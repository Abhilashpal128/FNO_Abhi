import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixture } from './helpers.js';
import { DEMO_DAY, DEMO_NOW } from '../src/testing/demo.js';
import { CandleBuilder, candleId } from '../src/market/candles.js';
import { normalizeCandles, normalizeInstrument } from '../src/providers/upstox.js';
import { atIST, MINUTE } from '../src/market/time.js';
import { runBacktest, type ReplayDataset } from '../src/engines/backtest.js';

const open = atIST(DEMO_DAY, '09:15');
function minutes(receivedAt: number) {
  return normalizeCandles(
    {
      candles: Array.from({ length: 5 }, (_, i) => [
        new Date(open + i * MINUTE).toISOString(),
        100,
        103,
        99,
        102,
        200,
        0,
      ]),
    },
    'NSE_EQ|TEST_ONLY',
    1,
    receivedAt,
  );
}

describe('candle ingestion and first availability', () => {
  it('keeps one logical candle and the first receipt across a later historical download', async () => {
    const s = await fixture();
    const first = minutes(DEMO_NOW),
      later = minutes(DEMO_NOW + 86400000);
    expect(first[0]!.id).toBe(later[0]!.id);
    await s.market.persistHistory(first, DEMO_NOW);
    await s.market.persistHistory(later, DEMO_NOW + 86400000);
    const rows = await s.store.find('market_candles', { instrumentKey: 'NSE_EQ|TEST_ONLY' });
    expect(rows).toHaveLength(6);
    expect(rows.every((c) => c.receivedAt === DEMO_NOW)).toBe(true);
    const profiles = await s.store.find('market_volume_profiles', { instrumentKey: 'NSE_EQ|TEST_ONLY' });
    expect(profiles).toHaveLength(6);
    expect(profiles.every((p) => p.receivedAt === DEMO_NOW)).toBe(true);
    expect(rows.find((c) => c.interval === 5)?.volume).toBe(1000);
  });
  it('timestamps corrections when received and invalidates unsuitable baseline samples', async () => {
    const s = await fixture(),
      first = minutes(DEMO_NOW);
    await s.market.persistHistory(first, DEMO_NOW);
    const corrected = first.map((c) => ({ ...c, receivedAt: DEMO_NOW + 1000 }));
    corrected[0] = { ...corrected[0]!, volume: null, quality: ['PROVIDER_CORRECTION_INCOMPLETE'] };
    await s.market.persistHistory(corrected, DEMO_NOW + 1000);
    const aggregate = await s.store.get('market_candles', candleId(first[0]!.instrumentKey, 5, open));
    expect(aggregate?.receivedAt).toBe(DEMO_NOW + 1000);
    expect(aggregate?.volume).toBeNull();
    expect(
      (
        await s.store.find('market_volume_profiles', { instrumentKey: first[0]!.instrumentKey, interval: 5 })
      )[0]?.valid,
    ).toBe(false);
  });
  it('does not mark sampled tick volume reliable after a timed flush across the minute boundary', async () => {
    const s = await fixture(),
      template = s.market.quotes.get('DEMO|ACME')!,
      builder = new CandleBuilder();
    const q = (ts: number, volume: number) => ({
      ...template,
      sourceTs: ts,
      receivedAt: ts,
      lastTradeTs: ts,
      cumulativeVolume: volume,
    });
    builder.push(q(open + 59000, 1000), open, open + 10 * MINUTE);
    const closed = builder.flush(open + MINUTE + 100, 100);
    expect(closed[0]?.receivedAt).toBe(open + MINUTE + 100);
    builder.push(q(open + MINUTE + 200, 1100), open, open + 10 * MINUTE);
    builder.push(q(open + MINUTE + 1000, 1200), open, open + 10 * MINUTE);
    const next = builder.flush(open + 2 * MINUTE + 100, 100)[0]!;
    expect(next.volume).toBeNull();
    expect(next.quality).toContain('CROSS_MINUTE_VOLUME_ALLOCATION_UNCERTAIN');
    expect(next.quality).toContain('SAMPLED_TICK_OHLC');
  });
  it('preserves official OHLC when a later tick approximation is flushed', async () => {
    const s = await fixture(),
      c = minutes(DEMO_NOW)[0]!;
    await s.market.persistCandle(c);
    await s.market.persistCandle({ ...c, high: 110, receivedAt: DEMO_NOW + 1000, source: 'upstox-v3-ticks' });
    expect((await s.store.get('market_candles', c.id))?.high).toBe(103);
  });
  it('finalizes a daily bar conservatively at next IST midnight, not next session opening', () => {
    const row = { candles: [[new Date(open).toISOString(), 100, 103, 99, 102, 200, 0]] };
    const midnight = atIST('2026-10-22', '00:00');
    expect(normalizeCandles(row, 'NSE_EQ|TEST_ONLY', 1440, midnight - 1)[0]?.complete).toBe(false);
    const final = normalizeCandles(row, 'NSE_EQ|TEST_ONLY', 1440, midnight)[0]!;
    expect(final.end).toBe(midnight);
    expect(final.complete).toBe(true);
  });
  it('rejects invalid expiry, strike and negative lot metadata', () => {
    const raw = {
      instrument_key: 'NSE_FO|TEST_ONLY',
      trading_symbol: 'TEST',
      instrument_type: 'CE',
      segment: 'NSE_FO',
      underlying_key: 'NSE_EQ|TEST_ONLY',
      expiry: '2026-11-26',
      strike_price: 100,
      lot_size: 50,
      tick_size: 5,
    };
    expect(normalizeInstrument(raw, DEMO_NOW)?.tickSize).toBe(0.05);
    for (const change of [
      { expiry: 'invalid' },
      { expiry: '2026-02-31' },
      { lot_size: -50 },
      { strike_price: 0 },
    ])
      expect(normalizeInstrument({ ...raw, ...change }, DEMO_NOW)).toBeNull();
  });
});

describe('point-in-time metadata and calendar revisions', () => {
  it('keeps removed calendar events visible only in the version known at the decision', async () => {
    const s = await fixture();
    const directory = resolve('.cache/tests');
    await mkdir(directory, { recursive: true });
    const temporary = await mkdtemp(join(directory, 'calendar-')),
      path = join(temporary, 'calendar.json');
    s.config.EVENT_CALENDAR_PATH = path;
    try {
      const calendar = {
        validFrom: DEMO_DAY,
        validUntil: DEMO_DAY,
        source: 'synthetic regression fixture',
        events: [
          {
            id: 'event',
            title: 'Synthetic test event',
            start: DEMO_NOW + MINUTE,
            end: DEMO_NOW + 60 * MINUTE,
            instrumentKeys: [],
            impact: 'HIGH',
            publishedAt: DEMO_NOW - MINUTE,
          },
        ],
      };
      await writeFile(path, JSON.stringify(calendar));
      await s.news.loadEvents(DEMO_NOW);
      await writeFile(path, JSON.stringify({ ...calendar, events: [] }));
      await s.news.loadEvents(DEMO_NOW + 1000);
      expect((await s.news.context('DEMO|ACME', DEMO_NOW)).highImpact).toBe(true);
      expect((await s.news.context('DEMO|ACME', DEMO_NOW + 1000)).highImpact).toBe(false);
      expect(await s.store.find('event_calendar_versions')).toHaveLength(2);
    } finally {
      await unlink(path);
      await rmdir(temporary);
    }
  });
  it('replays recorded metadata instead of a later master and enforces the requested end time', async () => {
    const s = await fixture(),
      report = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW);
    const signal = (await s.store.get('trade_signals', report.signalIds[0]!))!;
    const original = signal.quote;
    const entry = {
      ...original,
      id: 'entry',
      sourceTs: DEMO_NOW + 1000,
      receivedAt: DEMO_NOW + 1000,
      lastTradeTs: DEMO_NOW + 1000,
    };
    const exit = {
      ...entry,
      id: 'exit',
      bid: signal.scenario.target2 + 1,
      ask: signal.scenario.target2 + 1.05,
      sourceTs: DEMO_NOW + 10000,
      receivedAt: DEMO_NOW + 10000,
      lastTradeTs: DEMO_NOW + 10000,
    };
    const bars = await s.store.find('market_candles', { interval: 1 });
    const dataset: ReplayDataset = {
      id: 'version-replay',
      createdAt: DEMO_NOW + 20000,
      underlying: signal.underlying,
      contract: { ...signal.contract, asOf: DEMO_NOW + 86400000 },
      underlyingCandles: bars,
      volumeCandles: bars,
      profiles: await s.store.find('market_volume_profiles'),
      quotes: [original, entry, exit],
      from: open,
      to: DEMO_NOW + 10000,
      eventCalendarReady: true,
    };
    expect(runBacktest(dataset, s.config).trades).toHaveLength(0);
    dataset.instrumentVersions = [
      {
        id: 'version',
        instrumentKey: signal.contract.id,
        asOf: signal.contract.asOf,
        instrument: signal.contract,
        mode: 'demo',
      },
    ];
    expect(runBacktest(dataset, s.config).trades).toHaveLength(1);
    const truncated = runBacktest({ ...dataset, to: DEMO_NOW }, s.config);
    expect(truncated.trades).toHaveLength(0);
    expect(truncated.limitations.some((l) => l.includes('no next-quote fill'))).toBe(true);
  });
});
