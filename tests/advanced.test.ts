import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Candle, Opportunity, Quote, NewsItem } from '../src/domain.js';
import { fixture } from './helpers.js';
import { DEMO_DAY, DEMO_NOW } from '../src/testing/demo.js';
import { atIST, MINUTE } from '../src/market/time.js';
import { candleId } from '../src/market/candles.js';
import { MinuteSampler, compactOptions } from '../src/market/sampling.js';
import {
  advancedVolume,
  volumeMoments,
  volumeAcceleration,
  onBalanceVolume,
  accumulationDistribution,
  priceVolumeDivergence,
} from '../src/engines/advanced-volume.js';
import { StrategyRegistry } from '../src/engines/strategy.js';
import {
  OutcomeAccumulator,
  outcomeFromCandles,
  calibrationMetrics,
  populationStability,
  chronologicalSplits,
} from '../src/engines/evaluation.js';
import { StorageHealthService, assessStorage } from '../src/services/storage.js';
import { MemoryStore } from '../src/db/store.js';
import { automaticExpiry, defaultRetention } from '../src/db/retention.js';
import { canonicalNewsUrl, officialNewsSource as officialSource } from '../src/providers/news.js';
import { clusterNews, createBriefing, validateExtraction } from '../src/services/briefing.js';

let s: Awaited<ReturnType<typeof fixture>>, signal: Opportunity;
const open = atIST(DEMO_DAY, '09:15');
function candle(i: number, volume = 100, close = 101): Candle {
  return {
    id: candleId('TEST', 1, open + i * MINUTE),
    instrumentKey: 'TEST',
    interval: 1,
    start: open + i * MINUTE,
    end: open + (i + 1) * MINUTE,
    receivedAt: open + (i + 1) * MINUTE,
    open: 100,
    high: 104,
    low: 98,
    close,
    volume,
    oi: null,
    complete: true,
    quality: [],
    source: 'test',
    mode: 'demo',
  };
}
const news: NewsItem = {
  id: 'n1',
  headline: 'RBI announces policy decision today',
  summary: 'Policy rates remain unchanged.',
  url: 'https://www.rbi.org.in/test',
  source: 'RBI',
  publishedAt: open - 3600000,
  receivedAt: open - 3500000,
  instrumentKeys: ['TEST'],
  official: true,
  classification: 'POLICY',
  sentiment: 'neutral',
  sentimentMethod: 'test',
  mode: 'demo',
};
beforeAll(async () => {
  s = await fixture();
  const run = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW);
  signal = (await s.store.get('trade_signals', run.signalIds[0]!))!;
});

describe('advanced volume mathematics and availability', () => {
  it('computes population SD and growth acceleration using independent expected values', () => {
    expect(volumeMoments([1, 2, 3])).toEqual({ mean: 2, stdDev: Math.sqrt(2 / 3) });
    expect(volumeAcceleration([100, 200, 600])).toBe(1);
    expect(volumeAcceleration([0, 200, 600])).toBeNull();
    expect(volumeMoments([-1]).mean).toBeNull();
  });
  it('rebases OBV and calculates ADL without dividing flat price ranges by zero', () => {
    expect(onBalanceVolume([candle(0, 100, 100), candle(1, 200, 102), candle(2, 150, 100)])).toBe(50);
    expect(accumulationDistribution([{ ...candle(0), high: 102, low: 100, close: 102 }])).toBe(100);
    expect(accumulationDistribution([{ ...candle(0), high: 100, low: 100, close: 100 }])).toBe(0);
    expect(onBalanceVolume([{ ...candle(0), volume: null }])).toBeNull();
  });
  it('identifies rising price with declining volume without claiming participant intent', () => {
    const rows = Array.from({ length: 6 }, (_, i) => candle(i, i < 3 ? 200 : 100, 101 + i));
    expect(priceVolumeDivergence(rows)).toBe('BEARISH');
  });
  it('excludes future receipt data and refuses a partial-session VWAP', () => {
    const rows = [candle(1), { ...candle(2), receivedAt: open + 10 * MINUTE }];
    const out = advancedVolume(rows, [], open + 4 * MINUTE, s.config);
    expect(out.sampleCount).toBe(1);
    expect(out.vwap).toBeNull();
    expect(out.volumeZScore).toBeNull();
    expect(out.sectorRelativeParticipation).toBeNull();
  });
  it('calculates session VWAP only from contiguous, completed, reliable minutes', () => {
    expect(advancedVolume([candle(0), candle(1)], [], open + 2 * MINUTE, s.config).vwap).toBe(101);
    expect(advancedVolume([candle(0), candle(2)], [], open + 3 * MINUTE, s.config).vwap).toBeNull();
    expect(advancedVolume([{ ...candle(0), volume: null }], [], open + MINUTE, s.config).obv).toBeNull();
  });
  it('records all ten new strategy assessments with version, timestamp and rejection evidence', () => {
    const assessments = new StrategyRegistry().assess({
      asOf: DEMO_NOW,
      latest: null,
      opening: null,
      technical: signal.technical,
      volume: signal.volume,
      regime: 'HIGH_VOLATILITY',
    });
    expect(assessments).toHaveLength(11); // Existing opening strategy plus ten additions.
    expect(
      assessments.every(
        (d) => d.status === 'REJECTED' && d.conflicts.length && d.asOf === DEMO_NOW && d.version,
      ),
    ).toBe(true);
    expect(new Set(assessments.map((d) => d.strategyId)).size).toBe(11);
  });
});

describe('bounded collection and verified retention', () => {
  const q = (i: number): Quote => ({
    ...signal.quote,
    id: `q${i}`,
    sourceTs: open + i * 100,
    receivedAt: open + i * 100,
    cumulativeVolume: 1000 + i,
    ltp: 100 + i / 100,
  });
  it('collapses hundreds of ticks into one completed-minute observation with a stable ID', () => {
    const a = new MinuteSampler(),
      b = new MinuteSampler();
    for (let i = 0; i < 500; i++) a.observe(q(i));
    expect(a.size).toBe(1);
    expect(a.completed(open + 59000)).toEqual([]);
    b.observe(q(499));
    expect(a.completed(open + MINUTE)).toEqual(b.completed(open + MINUTE));
    expect(a.completed(open + MINUTE)[0]?.sourceTs).toBe(open + 49900);
  });
  it('performs no Mongo-style writes per raw tick, then writes one bounded observation', async () => {
    const f = await fixture();
    f.market.selectSnapshots([signal.contract.id]);
    f.market.quotes.delete(signal.contract.id);
    const insert = vi.spyOn(f.store, 'insert'),
      put = vi.spyOn(f.store, 'put');
    for (let i = 0; i < 500; i++) await f.market.acceptQuote(q(i));
    expect(insert).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    await f.market.flushObservations(open + MINUTE);
    const rows = await f.store.find('option_snapshots', { id: `minute:${signal.contract.id}:${open}` });
    expect(rows).toHaveLength(1);
    await f.market.flushObservations(open + MINUTE + 1);
    expect(await f.store.find('option_snapshots', { id: rows[0]!.id })).toHaveLength(1);
  });
  it('stops optional persistence at the critical budget level while keeping latest quotes', async () => {
    const f = await fixture();
    f.market.selectSnapshots([signal.contract.id]);
    f.market.quotes.delete(signal.contract.id);
    f.market.snapshotStride = 0;
    await f.market.acceptQuote(q(1));
    await f.market.flushObservations(open + MINUTE);
    expect(f.market.quotes.get(signal.contract.id)?.sourceTs).toBe(q(1).sourceTs);
    expect(await f.store.find('option_snapshots', { id: `minute:${signal.contract.id}:${open}` })).toEqual(
      [],
    );
  });
  it('labels compact OHLC as sampled and preserves observed source timestamps', () => {
    const compact = compactOptions([q(0), q(499)], open, open + 5 * MINUTE)!;
    expect(compact.observedVolumeChange).toBe(499);
    expect(compact.quality).toContain('INCOMPLETE_MINUTE_COVERAGE');
    expect(compact.quality).toContain('SAMPLED_QUOTES_NOT_EXCHANGE_OHLC');
    expect(compact.lastSourceTs).toBe(q(499).sourceTs);
    expect(compactOptions([q(0)], open, open + MINUTE)).toBeNull();
  });
  it('does not arm source TTL automatically or expire audit records', async () => {
    expect(automaticExpiry('market_candles', candle(0), defaultRetention)).toBeNull();
    expect(automaticExpiry('option_snapshots', q(0), defaultRetention)).toBeNull();
    const store = new MemoryStore();
    await store.insert('trade_signals', signal);
    await expect(store.armRetention('trade_signals', [signal.id], open)).rejects.toThrow('audit');
    store.expireFixtures(open + 4000 * 86400000);
    expect(await store.get('trade_signals', signal.id)).not.toBeNull();
  });
  it('creates daily, aggregate and baseline history before expiring a complete source session', async () => {
    const f = await fixture(),
      store = f.store as MemoryStore;
    const rows = Array.from({ length: 375 }, (_, i) => candle(i));
    await store.putMany('market_candles', rows);
    const service = new StorageHealthService(store, f.market, f.config);
    const now = open + 86400000;
    await service.prepareRetention(now);
    expect((await store.get('retention_checkpoints', `TEST~${DEMO_DAY}`))?.status).toBe('READY');
    expect((await store.get('market_candles', candleId('TEST', 1440, open)))?.volume).toBe(37500);
    store.expireFixtures(open + 61 * 86400000);
    expect(await store.find('market_candles', { instrumentKey: 'TEST', interval: 1 })).toHaveLength(0);
    expect(await store.find('market_volume_profiles', { instrumentKey: 'TEST', interval: 1 })).toHaveLength(
      375,
    );
    expect(await store.get('market_candles', candleId('TEST', 5, open))).not.toBeNull();
  });
  it('keeps incomplete sessions and recovers option compaction after a missed flush', async () => {
    const f = await fixture(),
      store = f.store as MemoryStore;
    await store.put('market_candles', candle(0));
    await store.insert('option_snapshots', q(1));
    const service = new StorageHealthService(store, f.market, f.config);
    await service.prepareRetention(open + 86400000);
    expect((await store.get('retention_checkpoints', `TEST~${DEMO_DAY}`))?.status).toBe('INCOMPLETE');
    expect(await store.get('option_aggregates', `compact:${signal.contract.id}:${open}`)).not.toBeNull();
    store.expireFixtures(open + 61 * 86400000);
    expect(await store.get('market_candles', candle(0).id)).not.toBeNull();
    expect(await store.get('option_snapshots', q(1).id)).toBeNull();
  });
  it.each([
    [59, 'NORMAL', 1],
    [60, 'WARNING', 1],
    [75, 'REDUCED', 5],
    [90, 'CRITICAL', 0],
  ] as const)('uses %s percent budget to enter %s', (pct, level, stride) => {
    const stats = {
      measured: true,
      collections: [],
      dataBytes: 0,
      storageBytes: 0,
      indexBytes: 0,
      totalBytes: (s.config.STORAGE_BUDGET_MB * 1024 * 1024 * pct) / 100,
    };
    const report = assessStorage(stats, null, DEMO_NOW, s.config, {
      status: 'OK',
      checkedAt: DEMO_NOW,
      armed: 0,
      pending: 0,
    });
    expect(report.level).toBe(level);
    expect(report.optionalSnapshotStride).toBe(stride);
    expect(report.daysToThreshold).toBeNull();
  });
});

describe('source grounded news', () => {
  it('deduplicates tracking URLs and refuses lookalike official hosts', () => {
    expect(canonicalNewsUrl('https://www.rbi.org.in/a?utm_source=x&id=7')).toBe(
      'https://www.rbi.org.in/a?id=7',
    );
    expect(officialSource('https://www.rbi.org.in/rss', 'https://www.rbi.org.in/a')).toBe(true);
    expect(officialSource('https://www.rbi.org.in.evil.test/rss', 'https://www.rbi.org.in/a')).toBe(false);
    expect(clusterNews([news, { ...news, id: 'n2' }])).toHaveLength(1);
  });
  it('rejects unknown citations, fabricated excerpts and uncited paraphrases', () => {
    const event = {
      category: 'POLICY',
      summary: news.headline,
      sourceIds: ['n1'],
      evidence: [{ sourceId: 'n1', quote: news.headline }],
    };
    expect(validateExtraction({ events: [event] }, [news])[0]?.verification).toBe('OFFICIAL_SOURCE');
    expect(() => validateExtraction({ events: [{ ...event, sourceIds: ['fake'] }] }, [news])).toThrow();
    expect(() =>
      validateExtraction({ events: [{ ...event, summary: 'Rate cuts guarantee profits' }] }, [news]),
    ).toThrow();
    expect(() =>
      validateExtraction(
        { events: [{ ...event, evidence: [{ sourceId: 'n1', quote: 'An invented quote' }] }] },
        [news],
      ),
    ).toThrow();
  });
  it('excludes late receipts from the fixed 09:00 cutoff and degrades without a model', async () => {
    const cutoff = atIST(DEMO_DAY, '09:00'),
      transport = vi.fn();
    const result = await createBriefing(
      [news, { ...news, id: 'late', receivedAt: cutoff + 1 }],
      cutoff,
      cutoff + 20,
      s.config,
      transport,
    );
    expect(result.sourceIds).toEqual(['n1']);
    expect(result.status).toBe('DEGRADED');
    expect(result.sources[0]?.summary).toBe(news.summary);
    expect(transport).not.toHaveBeenCalled();
  });
  it('accepts only schema-valid grounded local model output and sends no tools', async () => {
    const transport = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).tools).toBeUndefined();
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              events: [
                {
                  category: 'POLICY',
                  summary: news.headline,
                  sourceIds: ['n1'],
                  evidence: [{ sourceId: 'n1', quote: news.headline }],
                },
              ],
            }),
          },
        }),
      );
    });
    const brief = await createBriefing(
      [news],
      open,
      open + 1,
      { ...s.config, OLLAMA_BASE_URL: 'http://127.0.0.1:11434' },
      transport,
    );
    expect(brief.status).toBe('READY');
    expect(brief.events).toHaveLength(1);
  });
});

describe('candidate-time outcome quality and validation', () => {
  function observation(offset: number, bid: number, ask = bid + 0.1): Quote {
    return {
      ...signal.quote,
      sourceTs: signal.createdAt + offset,
      receivedAt: signal.createdAt + offset,
      bid,
      ask,
      bidQty: 10000,
      askQty: 10000,
      ltp: bid,
    };
  }
  it('distinguishes an observed research target from a paper fill', () => {
    const tracker = new OutcomeAccumulator(signal, signal.createdAt + MINUTE, 15000);
    tracker.observe(observation(1000, signal.scenario.entryLow, signal.scenario.entryLow));
    tracker.observe(observation(2000, signal.scenario.target2));
    const result = tracker.finish(signal.createdAt + MINUTE, false);
    expect(result.status).toBe('TARGET_BEFORE_STOP');
    expect(result.paperFilled).toBe(false);
    expect(result.candidateAt).toBe(signal.createdAt);
  });
  it('does not label gaps or a target reached before any entry as a win', () => {
    const tracker = new OutcomeAccumulator(signal, signal.createdAt + MINUTE, 15000);
    tracker.observe(observation(40000, signal.scenario.target2));
    expect(tracker.finish(signal.createdAt + MINUTE).status).toBe('DATA_UNAVAILABLE');
    const noEntry = new OutcomeAccumulator(
      { ...signal, quote: observation(-1, signal.scenario.target2) },
      signal.createdAt + MINUTE,
      15000,
    );
    noEntry.observe(observation(1000, signal.scenario.target2));
    noEntry.observe(observation(2000, signal.scenario.entryLow, signal.scenario.entryLow));
    expect(noEntry.finish(signal.createdAt + MINUTE).status).toBe('ENTRY_NOT_REACHED');
  });
  it('leaves same-bar target and stop ordering ambiguous', () => {
    const bar = {
      ...candle(0),
      instrumentKey: signal.contract.id,
      start: signal.createdAt,
      end: signal.createdAt + MINUTE,
      high: signal.scenario.target2 + 1,
      low: signal.scenario.stop - 1,
    };
    expect(outcomeFromCandles(signal, [bar], bar.end)).toBe('AMBIGUOUS');
  });
  it('purges training outcomes that overlap validation or its embargo', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: `${i}`,
      signalAt: 1 + i * MINUTE,
      horizonEnd: 1 + (i + 2) * MINUTE,
      availableAt: 1 + (i + 3) * MINUTE,
      label: (i % 2) as 0 | 1,
      regime: 'SIDEWAYS' as const,
      features: {},
      grossPnl: null,
      fees: null,
      slippage: null,
    }));
    for (const split of chronologicalSplits(rows, 3, MINUTE))
      expect(split.train.every((r) => r.availableAt < split.test[0]!.signalAt - MINUTE)).toBe(true);
  });
  it('reports calibration and drift without invented metrics for missing data', () => {
    expect(calibrationMetrics([0, 1], [0.25, 0.75]).brier).toBe(0.0625);
    expect(calibrationMetrics([], []).brier).toBeNull();
    expect(populationStability([], [])).toBeNull();
    const same = Array.from({ length: 100 }, (_, i) => i);
    expect(populationStability(same, same)).toBe(0);
    expect(
      populationStability(
        same,
        same.map((x) => x + 100),
      ),
    ).toBeGreaterThan(0);
  });
});
