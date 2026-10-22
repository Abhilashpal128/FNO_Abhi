import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoStore } from '../src/db/store.js';
import { fixture } from './helpers.js';
import { DEMO_NOW } from '../src/testing/demo.js';
import { snapshotHash } from '../src/services/analysis.js';
import { resolve } from 'node:path';
describe('real MongoDB replica-set transactions and unique indexes', () => {
  let repl: MongoMemoryReplSet, store: MongoStore;
  beforeAll(async () => {
    repl = await MongoMemoryReplSet.create({
      binary: { downloadDir: resolve('.cache/mongodb'), version: '8.0.12' },
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    store = await MongoStore.connect(repl.getUri('stockss_integration'));
  });
  afterAll(async () => {
    await store?.close();
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
});
