import type { Store } from '../db/store.js';
import type { Candle, Instrument, Quote } from '../domain.js';
import type { MarketService } from '../services/market.js';
import { addDays, atIST, demoSession, MINUTE, minuteOfDay } from '../market/time.js';
import { aggregateCandles, candleId } from '../market/candles.js';
export const DEMO_DAY = '2026-10-21';
export const DEMO_NOW = atIST(DEMO_DAY, '09:20') + 2000;
/** Deliberately fictional identities, fixed clock and arithmetic fixture prices. Never exchange-listed claims. */
export async function seedDemo(store: Store, market: MarketService) {
  if (market.config.DATA_MODE !== 'demo') throw new Error('Synthetic fixtures are prohibited in live mode');
  const open = atIST(DEMO_DAY, '09:15'),
    session = demoSession(DEMO_DAY);
  session.trading = true;
  await store.put('market_sessions', session);
  market.session = session;
  const underlying: Instrument = {
    id: 'DEMO|ACME',
    name: 'SYNTHETIC ACME (not a listed security)',
    tradingSymbol: 'DEMO_ACME',
    kind: 'EQUITY',
    underlyingKey: 'DEMO|ACME',
    underlyingType: 'EQUITY',
    expiry: null,
    strike: null,
    lotSize: 1,
    tickSize: 0.05,
    active: true,
    asOf: open - MINUTE,
    mode: 'demo',
    sector: 'SYNTHETIC',
  };
  const contract: Instrument = {
    ...underlying,
    id: 'DEMO|ACME_CE',
    kind: 'CE',
    name: 'SYNTHETIC ACME CALL',
    tradingSymbol: 'DEMO_ACME_1010_CE',
    underlyingKey: underlying.id,
    expiry: '2026-11-26',
    strike: 1010,
    lotSize: 100,
  };
  for (const i of [underlying, contract]) {
    await store.put('instruments', i);
    market.instruments.set(i.id, i);
  }
  market.underlyings = [underlying];
  market.volumeKeys.set(underlying.id, underlying.id);
  const all: Candle[] = [];
  const previous = atIST(addDays(DEMO_DAY, -1), '12:00');
  for (let i = 0; i < 180; i++) {
    const start = previous + i * MINUTE,
      price = 970 + i * 0.16;
    all.push({
      id: candleId(underlying.id, 1, start),
      instrumentKey: underlying.id,
      interval: 1,
      start,
      end: start + MINUTE,
      open: price,
      high: price + 0.4,
      low: price - 0.1,
      close: price + 0.2,
      volume: 2000,
      oi: null,
      complete: true,
      quality: [],
      source: 'SYNTHETIC_FIXTURE',
      receivedAt: start + MINUTE,
      mode: 'demo',
    });
  }
  const openingRows = [
    [1000, 1003, 999, 1002],
    [1002, 1005, 1001, 1004],
    [1004, 1007, 1003, 1006],
    [1006, 1012, 1005, 1010],
    [1010, 1011, 1008, 1009],
  ];
  for (let i = 0; i < 5; i++) {
    const row = openingRows[i]!,
      start = open + i * MINUTE;
    all.push({
      id: candleId(underlying.id, 1, start),
      instrumentKey: underlying.id,
      interval: 1,
      start,
      end: start + MINUTE,
      open: row[0]!,
      high: row[1]!,
      low: row[2]!,
      close: row[3]!,
      volume: 6000,
      oi: null,
      complete: true,
      quality: [],
      source: 'SYNTHETIC_FIXTURE',
      receivedAt: start + MINUTE,
      mode: 'demo',
    });
  }
  for (const c of all) await store.put('market_candles', c);
  const opening = aggregateCandles(all, 5, open, DEMO_NOW)!;
  await store.put('market_candles', opening);
  for (let i = 1; i <= 20; i++) {
    const day = addDays(DEMO_DAY, -i);
    await store.put('market_volume_profiles', {
      id: `demo:${underlying.id}:${day}:5:555`,
      instrumentKey: underlying.id,
      day,
      minute: minuteOfDay(open),
      interval: 5,
      volume: 10000,
      valid: true,
      receivedAt: open - MINUTE,
      mode: 'demo',
    });
  }
  const q: Quote = {
    id: `demo:option:${DEMO_NOW}`,
    instrumentKey: contract.id,
    ltp: 60,
    bid: 59.95,
    ask: 60,
    bidQty: 5000,
    askQty: 5000,
    cumulativeVolume: 20000,
    oi: 50000,
    previousOi: 49000,
    oiAsOf: null,
    delta: 0.6,
    gamma: 0.0005,
    theta: -1,
    iv: 22,
    sourceTs: DEMO_NOW,
    receivedAt: DEMO_NOW,
    lastTradeTs: DEMO_NOW,
    mode: 'demo',
    quality: [],
  };
  const uq: Quote = {
    ...q,
    id: `demo:underlying:${DEMO_NOW}`,
    instrumentKey: underlying.id,
    ltp: 1009,
    bid: 1008.95,
    ask: 1009.05,
    cumulativeVolume: 30000,
    oi: null,
    delta: null,
    gamma: null,
    theta: null,
    iv: null,
  };
  for (const quote of [q, uq]) {
    market.quotes.set(quote.instrumentKey, quote);
    if (!(await store.get('option_snapshots', quote.id))) await store.insert('option_snapshots', quote);
  }
}
