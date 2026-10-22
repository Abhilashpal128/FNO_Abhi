import { describe, it, expect } from 'vitest';
import { configSchema } from '../src/config.js';
import type { Candle, VolumeProfile, Quote, Instrument } from '../src/domain.js';
import { CumulativeVolumeTracker, aggregateCandles } from '../src/market/candles.js';
import { atIST, addDays, dayKey, demoSession, fresh, sessionSchedule } from '../src/market/time.js';
import {
  vwap,
  historicalBaseline,
  priceVolumeRelationship,
  volumeIntelligence,
  VolumeCandidateFilter,
  derivativesVolume,
} from '../src/engines/volume.js';
import {
  sma,
  ema,
  rsi,
  macd,
  bollinger,
  atr,
  marketRegime,
  technicalFeatures,
} from '../src/engines/indicators.js';
import { spread, charges, buildScenario, defaultRisk, riskRejections } from '../src/engines/risk.js';
import { normalizeInstrument, normalizeCandles, normalizeChain } from '../src/providers/upstox.js';
import { MemoryStore } from '../src/db/store.js';
export const config = configSchema.parse({
  APP_PASSWORD_HASH: 'x'.repeat(64),
  JWT_SECRET: 't'.repeat(64),
  BASELINE_MIN_SAMPLES: 2,
  REQUIRE_EVENT_CALENDAR: 'false',
});
const start = atIST('2026-10-21', '09:15');
export function candle(i = 0, changes: Partial<Candle> = {}): Candle {
  return {
    id: `c${i}`,
    instrumentKey: 'DEMO|STOCK',
    interval: 1,
    start: start + i * 60000,
    end: start + (i + 1) * 60000,
    open: 100,
    high: 103,
    low: 99,
    close: 102,
    volume: 100,
    oi: null,
    complete: true,
    quality: [],
    source: 'synthetic-test',
    receivedAt: start + (i + 1) * 60000,
    mode: 'demo',
    ...changes,
  };
}
export function quote(changes: Partial<Quote> = {}): Quote {
  return {
    id: 'q',
    instrumentKey: 'DEMO|OPTION',
    ltp: 20,
    bid: 19.9,
    ask: 20,
    bidQty: 1000,
    askQty: 1000,
    cumulativeVolume: 10000,
    oi: 5000,
    previousOi: 4500,
    oiAsOf: null,
    delta: 0.5,
    gamma: 0.001,
    theta: -1,
    iv: 20,
    sourceTs: start + 300000,
    receivedAt: start + 300000,
    lastTradeTs: start + 300000,
    mode: 'demo',
    quality: [],
    ...changes,
  };
}
export function contract(changes: Partial<Instrument> = {}): Instrument {
  return {
    id: 'DEMO|OPTION',
    name: 'SYNTHETIC OPTION',
    tradingSymbol: 'SYNTHETIC CE',
    kind: 'CE',
    underlyingKey: 'DEMO|STOCK',
    underlyingType: 'EQUITY',
    expiry: '2026-11-26',
    strike: 100,
    lotSize: 50,
    tickSize: 0.05,
    active: true,
    asOf: start,
    mode: 'demo',
    sector: null,
    ...changes,
  };
}
describe('volume correctness', () => {
  it('calculates independently checkable candle VWAP', () => {
    expect(
      vwap([
        candle(0, { high: 12, low: 8, close: 10, volume: 100 }),
        candle(1, { high: 22, low: 18, close: 20, volume: 300 }),
      ]),
    ).toBe(17.5);
    expect(vwap([candle(0, { volume: null })])).toBeNull();
  });
  it('differences cumulative volume and rejects initial assumption', () => {
    const t = new CumulativeVolumeTracker();
    expect(t.observe('x', start, 500).volume).toBeNull();
    expect(t.observe('x', start + 1000, 560).volume).toBe(60);
    expect(t.observe('x', start + 1000, 560).flags).toContain('DUPLICATE_OR_OUT_OF_ORDER');
  });
  it('handles daily reset, negative corrections and observation gaps', () => {
    const t = new CumulativeVolumeTracker();
    t.observe('x', start, 500);
    expect(t.observe('x', start + 1000, 400).flags).toContain('VOLUME_CORRECTION');
    expect(t.observe('x', start + 2000, 420).volume).toBe(20);
    expect(t.observe('x', start + 90000, 500).volume).toBeNull();
    expect(t.observe('x', start + 86400000, 20).flags).toContain('SESSION_RESET');
  });
  it('does not invent index spot volume', () => {
    expect(new CumulativeVolumeTracker().observe('index', start, 500, true).volume).toBeNull();
  });
  it('requires all five completed opening minutes and actual interval close', () => {
    const rows = Array.from({ length: 5 }, (_, i) => candle(i));
    expect(aggregateCandles(rows, 5, start, start + 299999)).toBeNull();
    expect(aggregateCandles(rows.slice(1), 5, start, start + 300000)).toBeNull();
    expect(aggregateCandles(rows, 5, start, start + 300000)?.volume).toBe(500);
  });
  it('rejects duplicate minute positions in aggregation', () => {
    expect(
      aggregateCandles([candle(0), candle(0), candle(2), candle(3), candle(4)], 5, start, start + 300000),
    ).toBeNull();
  });
  it('compares identical time and duration, excluding future and missing samples', () => {
    const c = candle(0, { interval: 5, end: start + 300000, volume: 600 }),
      profiles: VolumeProfile[] = [1, 2, 3].map((d) => ({
        id: `p${d}`,
        instrumentKey: c.instrumentKey,
        day: addDays('2026-10-21', -d),
        minute: 555,
        interval: 5,
        volume: 200,
        valid: true,
        receivedAt: start - 1000,
        mode: 'demo',
      }));
    profiles.push({ ...profiles[0]!, id: 'wrong', minute: 560, volume: 99999 });
    expect(historicalBaseline(c, profiles, start + 300000, 20, 2)).toEqual({ average: 200, samples: 3 });
    const v = volumeIntelligence(c, c, [c], profiles, start + 300000, config);
    expect(v.openingFiveMinuteRvol).toBe(3);
    expect(new VolumeCandidateFilter(config).isSpike(v)).toBe(true);
    expect(v.volumeConfirmationStatus).toBe('CONFIRMED');
    expect(historicalBaseline(c, profiles, start + 300000, 20, 4).average).toBeNull();
  });
  it('classifies price and volume independently', () => {
    expect(priceVolumeRelationship(-0.02, 2)).toBe('FALLING_PRICE_EXPANDING_VOLUME');
    expect(priceVolumeRelationship(0, 2)).toBe('HIGH_VOLUME_WITHOUT_PRICE_PROGRESS');
    expect(priceVolumeRelationship(0.02, 0.5)).toBe('RISING_PRICE_DECLINING_VOLUME');
  });
  it('preserves OI freshness uncertainty', () => {
    const v = derivativesVolume(quote(), start + 300000);
    expect(v.oiChange).toBe(500);
    expect(v.optionVolumeToOI).toBe(2);
    expect(v.oiFreshnessKnown).toBe(false);
  });
});
describe('indicators and time', () => {
  it('matches hand calculated SMA EMA RSI and bands', () => {
    expect(sma([1, 2, 3, 4], 3)).toBe(3);
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(rsi(Array.from({ length: 16 }, (_, i) => i + 1))).toBe(100);
    expect(rsi(Array(16).fill(1))).toBe(50);
    expect(bollinger([1, 2, 3], 3)?.middle).toBe(2);
    expect(atr([candle()], 1)).toBe(4);
    expect(macd([1, 2])).toBeNull();
  });
  it('keeps insufficient regimes explicit', () => {
    expect(marketRegime(technicalFeatures([], start), 100, false)).toBe('INSUFFICIENT_DATA');
  });
  it('schedules 9:20, 9:35, 9:50 deep then 10:05 and 10:20 deep', () => {
    const tasks = sessionSchedule(demoSession('2026-10-21'));
    expect(tasks.slice(2, 7).map((t) => [t.kind, t.at])).toEqual([
      ['INITIAL', atIST('2026-10-21', '09:20')],
      ['REEVALUATION', atIST('2026-10-21', '09:35')],
      ['DEEP', atIST('2026-10-21', '09:50')],
      ['REEVALUATION', atIST('2026-10-21', '10:05')],
      ['DEEP', atIST('2026-10-21', '10:20')],
    ]);
  });
  it('handles IST day boundaries, holidays and special sessions', () => {
    expect(dayKey(Date.parse('2026-10-20T20:00:00Z'))).toBe('2026-10-21');
    expect(sessionSchedule({ ...demoSession('2026-10-21'), trading: false })).toEqual([]);
    expect(sessionSchedule(demoSession('2026-10-24'))).toEqual([]);
    const s = {
      ...demoSession('2026-10-21'),
      open: atIST('2026-10-21', '18:00'),
      close: atIST('2026-10-21', '19:00'),
    };
    expect(sessionSchedule(s)[2]?.at).toBe(atIST('2026-10-21', '18:05'));
  });
  it('rejects stale and future quotes', () => {
    expect(fresh(start, start, start + 1000, 2000)).toBe(true);
    expect(fresh(start, start, start + 3000, 2000)).toBe(false);
    expect(fresh(start + 1, start + 1, start, 2000)).toBe(false);
  });
});
describe('contracts, cost and risk', () => {
  it('maps actual provider keys, expiry, lot and paise tick without invented strikes', () => {
    const i = normalizeInstrument(
      {
        instrument_key: 'NSE_FO|123',
        trading_symbol: 'EXAMPLE',
        instrument_type: 'CE',
        segment: 'NSE_FO',
        underlying_key: 'NSE_EQ|ABC',
        underlying_type: 'EQUITY',
        expiry: '2026-11-26',
        strike_price: 100,
        lot_size: 250,
        tick_size: 5,
      },
      start,
    );
    expect(i?.id).toBe('NSE_FO|123');
    expect(i?.lotSize).toBe(250);
    expect(i?.tickSize).toBe(0.05);
    expect(normalizeInstrument({ instrument_key: 'fake' }, start)).toBeNull();
  });
  it('normalizes OHLCV without turning incomplete data into completed data', () => {
    const rows = normalizeCandles(
      { candles: [['2026-10-21T09:15:00+05:30', 100, 103, 99, 102, 200, 500]] },
      'NSE_EQ|ABC',
      5,
      start + 1000,
    );
    expect(rows[0]?.complete).toBe(false);
  });
  it('chain quotes without source timestamps cannot become live fills', () => {
    const rows = normalizeChain(
      [
        {
          expiry: '2026-11-26',
          strike_price: 100,
          underlying_key: 'X',
          call_options: {
            instrument_key: 'C',
            market_data: {
              ltp: 10,
              volume: 100,
              oi: 200,
              bid_price: 9,
              ask_price: 10,
              bid_qty: 50,
              ask_qty: 50,
            },
            option_greeks: { delta: 0.5 },
          },
        },
      ],
      start,
    );
    expect(rows[0]?.sourceTs).toBe(0);
  });
  it('calculates spread and rejects crossed markets', () => {
    expect(spread(quote()).absolute).toBeCloseTo(0.1);
    expect(spread(quote({ bid: 21, ask: 20 })).percentage).toBeNull();
  });
  it('includes real lot quantity, fees, slippage and tick rounding in research risk', () => {
    const d = {
      strategyId: 'x',
      version: '1',
      direction: 'BULLISH' as const,
      underlyingEntry: 1000,
      invalidation: 995,
      target1: 1010,
      target2: 1015,
      reasons: [],
      conflicts: [],
    };
    const s = buildScenario(contract(), quote(), d, config)!;
    expect(s).not.toBeNull();
    expect(s.plannedLoss).toBeGreaterThan((s.entryHigh - s.stop) * 50);
    expect(s.oneLotCapital).toBeGreaterThan(s.entryHigh * 50);
    expect(s.entryHigh / 0.05).toBeCloseTo(Math.round(s.entryHigh / 0.05));
    expect(charges(20, 50, 'SELL', config)).toBeGreaterThan(20);
  });
  it('enforces no trade and expiry restrictions even on otherwise eligible quotes', () => {
    const s = {
      entryLow: 20,
      entryHigh: 20.05,
      stop: 18,
      target1: 25,
      target2: 28,
      quantity: 50,
      oneLotCapital: 1030,
      plannedLoss: 160,
      estimatedCosts: 57.5,
      rewardRisk: 2,
      methodology: 'fixture',
      underlyingInvalidation: 99,
    };
    const r = riskRejections(
      contract({ expiry: '2026-10-22' }),
      quote(),
      s,
      {
        now: start + 300000,
        settings: { ...defaultRisk(config, start), globalNoTrade: true },
        dailyLoss: 0,
        aggregateRisk: 0,
        correlatedRisk: 0,
        availableCash: 10000,
        dailyCount: 5,
        highImpactEvent: false,
        eventCalendarReady: true,
      },
      config,
    );
    expect(r).toContain('GLOBAL_NO_TRADE');
    expect(r).toContain('DAILY_OPPORTUNITY_LIMIT');
    expect(r).toContain('EXPIRY_OR_PHYSICAL_SETTLEMENT_RESTRICTION');
  });
});
describe('persistence safety', () => {
  it('rolls back failed atomic fixture operations', async () => {
    const store = new MemoryStore();
    await expect(
      store.transaction(async (db) => {
        await db.put('system_health', { id: 'x', status: 'OK', checkedAt: 1, details: [] });
        throw Error('rollback');
      }),
    ).rejects.toThrow();
    expect(await store.get('system_health', 'x')).toBeNull();
  });
  it('enforces append-only signal history', async () => {
    const store = new MemoryStore();
    await expect(
      store.put('signal_events', {
        id: 'x',
        signalId: 'y',
        timestamp: 1,
        status: 'WATCHING',
        reason: 'test',
        quoteId: null,
      }),
    ).rejects.toThrow('append-only');
  });
});
