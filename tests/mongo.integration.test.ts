import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoStore } from '../src/db/store.js';
import { fixture } from './helpers.js';
import { DEMO_NOW } from '../src/testing/demo.js';
import { snapshotHash } from '../src/services/analysis.js';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
import { expirable } from '../src/db/retention.js';
describe('real MongoDB replica-set transactions and unique indexes', () => {
  let repl: MongoMemoryReplSet, store: MongoStore;
  let inspector: mongoose.mongo.MongoClient;
  beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({
      binary: { downloadDir: resolve('.cache/mongodb'), version: '8.0.12' },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
      instanceOpts: [{ args: ['--setParameter', 'ttlMonitorSleepSecs=1'] }],
    });
    store = await MongoStore.connect(repl.getUri('stockss_integration'));
    inspector = await new mongoose.mongo.MongoClient(repl.getUri('stockss_integration')).connect();
  });
  afterAll(async () => {
    await store?.close();
    await inspector?.close();
    await repl?.stop();
  });
  it('admits one immutable opportunity and one paper fill across concurrent transactions', async () => {
    const s = await fixture(store);
    const runs = await Promise.all([
      s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW),
      s.analysis.evaluate('MANUAL', DEMO_NOW, DEMO_NOW),
    ]);
    const signals = await store.find('trade_signals');
    expect(signals).toHaveLength(1);
    expect(snapshotHash(signals[0]!)).toBe(signals[0]?.snapshotHash);
    expect(runs[0]?.signalIds).toHaveLength(1);
    const trades = await Promise.all([
      s.paper.open(signals[0]!.id, 1, 'mongo-entry-key', DEMO_NOW),
      s.paper.open(signals[0]!.id, 1, 'mongo-entry-key', DEMO_NOW),
    ]);
    expect(trades[0]?.id).toBe(trades[1]?.id);
    expect(await store.find('paper_trade_executions')).toHaveLength(1);
  });
  it('rolls back failed MongoDB transactions', async () => {
    await expect(
      store.transaction(async (db) => {
        await db.put('system_health', {
          id: 'rollback-check',
          status: 'OK',
          checkedAt: DEMO_NOW,
          details: [],
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await store.get('system_health', 'rollback-check')).toBeNull();
  });
  it('enforces append-only policy at repository and persisted id uniqueness', async () => {
    const signal = (await store.find('trade_signals'))[0]!;
    await expect(store.put('trade_signals', signal)).rejects.toThrow('append-only');
    await expect(store.insert('trade_signals', signal)).rejects.toThrow('already exists');
  });
  it('bulk ingestion shares transaction rollback and prevents duplicate live/historical candles', async () => {
    const candle = (await store.find('market_candles', { interval: 1 }))[0]!;
    await expect(
      store.insert('market_candles', { ...candle, id: 'duplicate-history', mode: 'historical' }),
    ).rejects.toThrow('already exists');
    await expect(
      store.transaction(async (db) => {
        await db.putMany('system_health', [
          { id: 'bulk-rollback', status: 'OK', checkedAt: DEMO_NOW, details: [] },
        ]);
        throw new Error('bulk rollback');
      }),
    ).rejects.toThrow('bulk rollback');
    expect(await store.get('system_health', 'bulk-rollback')).toBeNull();
    await expect(store.putMany('trade_signals', await store.find('trade_signals'))).rejects.toThrow(
      'append-only',
    );
    const rows = Array.from({ length: 1001 }, (_, i) => ({
      id: `bulk-${i}`,
      status: 'OK' as const,
      checkedAt: DEMO_NOW,
      details: [],
    }));
    await store.putMany('system_health', rows);
    expect(
      await store.find('system_health', { id: { $in: rows.map((r) => r.id) } }, { limit: 1100 }),
    ).toHaveLength(1001);
  });
  it('indexes only authorized ephemeral collections for TTL and measures physical storage', async () => {
    const db = inspector.db('stockss_integration');
    for (const collection of await db.listCollections().toArray()) {
      const indexes = await db.collection(collection.name).indexes();
      const ttl = indexes.filter((i) => i.expireAfterSeconds !== undefined);
      expect(ttl.length, collection.name).toBe(expirable.has(collection.name as never) ? 1 : 0);
      if (ttl.length) {
        expect(ttl[0]?.key).toEqual({ retentionAt: 1 });
        expect(ttl[0]?.expireAfterSeconds).toBe(0);
      }
    }
    const stats = await store.storageStats();
    expect(stats.measured).toBe(true);
    expect(stats.totalBytes).toBe(stats.storageBytes + stats.indexBytes);
    expect(stats.indexBytes).toBeGreaterThan(0);
    expect(stats.collections.some((c) => c.name === 'trade_signals' && c.count === 1)).toBe(true);
  });
  it('deduplicates batches, uses a Date TTL and lets Mongo expire only armed source data', async () => {
    const template = (await store.find('option_snapshots', {}, { limit: 1 }))[0]!;
    const q = { ...template, id: 'ttl-integration-only', sourceTs: Date.now(), receivedAt: Date.now() };
    await store.insertMany('option_snapshots', [q, q]);
    const collection = inspector.db('stockss_integration').collection('option_snapshots');
    expect((await collection.findOne({ id: q.id }))?.retentionAt).toBeUndefined();
    await store.armRetention('option_snapshots', [q.id], Date.now() - 1000);
    const raw = await collection.findOne({ id: q.id });
    if (raw) expect(raw.retentionAt).toBeInstanceOf(Date);
    await expect.poll(() => store.get('option_snapshots', q.id), { timeout: 15000, interval: 200 }).toBeNull();
    const signal = (await store.find('trade_signals'))[0]!;
    await expect(store.armRetention('trade_signals', [signal.id], Date.now())).rejects.toThrow('audit');
    expect(await store.get('trade_signals', signal.id)).not.toBeNull();
  });
});
