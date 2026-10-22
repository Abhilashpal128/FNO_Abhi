import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Candle, Instrument, MarketSession, Quote, NewsItem } from '../domain.js';
import { addDays, atIST, dayKey, MINUTE } from '../market/time.js';
import { createHash } from 'node:crypto';
import { candleId } from '../market/candles.js';

const num = z.number().finite(),
  timestamp = z.coerce.number().int().positive().safe();
const rawInstrument = z.object({
  instrument_key: z.string(),
  name: z.string().optional(),
  trading_symbol: z.string(),
  instrument_type: z.string(),
  segment: z.string(),
  underlying_key: z.string().optional(),
  underlying_type: z.string().optional(),
  expiry: z.union([z.string(), num]).optional(),
  strike_price: num.optional(),
  lot_size: num.optional(),
  tick_size: num.optional(),
});
export function normalizeInstrument(raw: unknown, asOf: number): Instrument | null {
  const p = rawInstrument.safeParse(raw);
  if (!p.success) return null;
  const r = p.data;
  if (!['NSE_FO', 'NSE_EQ', 'NSE_INDEX'].includes(r.segment)) return null;
  const kind = r.segment === 'NSE_INDEX' ? 'INDEX' : r.segment === 'NSE_EQ' ? 'EQUITY' : r.instrument_type;
  if (!['CE', 'PE', 'FUT', 'INDEX', 'EQUITY'].includes(kind)) return null;
  const derivative = ['CE', 'PE', 'FUT'].includes(kind),
    expiry =
      r.expiry === undefined ? null : typeof r.expiry === 'number' ? dayKey(r.expiry) : r.expiry.slice(0, 10);
  if (
    derivative &&
    (!r.underlying_key ||
      !expiry ||
      !z.iso.date().safeParse(expiry).success ||
      !r.lot_size ||
      r.lot_size < 1 ||
      !r.tick_size ||
      r.tick_size <= 0 ||
      !Number.isInteger(r.lot_size) ||
      (['CE', 'PE'].includes(kind) && (r.strike_price === undefined || r.strike_price <= 0)))
  )
    return null;
  return {
    id: r.instrument_key,
    name: r.name ?? r.trading_symbol,
    tradingSymbol: r.trading_symbol,
    kind: kind as Instrument['kind'],
    underlyingKey: r.underlying_key ?? r.instrument_key,
    underlyingType: r.underlying_type === 'INDEX' || kind === 'INDEX' ? 'INDEX' : 'EQUITY',
    expiry,
    strike: r.strike_price ?? null,
    lotSize: r.lot_size ?? 1,
    tickSize: (r.tick_size ?? 0) / 100,
    rawTickSize: r.tick_size,
    active: expiry === null || expiry >= dayKey(asOf),
    asOf,
    mode: 'live',
    sector: null,
  };
}
const candleRow = z.tuple([z.string(), num, num, num, num, num]).rest(num);
export function normalizeCandles(
  data: unknown,
  key: string,
  interval: number,
  receivedAt: number,
  source = 'upstox-v3-history',
): Candle[] {
  const parsed = z.object({ candles: z.array(candleRow) }).parse(data);
  return parsed.candles
    .flatMap((row) => {
      const [startText, open, high, low, close, volume, oi] = row,
        start = Date.parse(startText);
      if (
        !Number.isFinite(start) ||
        !Number.isInteger(interval) ||
        interval < 1 ||
        open <= 0 ||
        close <= 0 ||
        low <= 0 ||
        high < Math.max(open, close, low) ||
        low > Math.min(open, close) ||
        volume < 0
      )
        return [];
      // A daily REST bar has no explicit finalization time. Wait until the next IST date.
      const end = interval === 1440 ? atIST(addDays(dayKey(start), 1), '00:00') : start + interval * MINUTE;
      return [
        {
          id: candleId(key, interval, start),
          instrumentKey: key,
          interval,
          start,
          end,
          open,
          high,
          low,
          close,
          volume: key.startsWith('NSE_INDEX|') ? null : volume,
          oi: oi ?? null,
          complete: end <= receivedAt,
          quality: [],
          source,
          receivedAt,
          mode: key.startsWith('DEMO|')
            ? ('demo' as const)
            : dayKey(start) === dayKey(receivedAt)
              ? ('live' as const)
              : ('historical' as const),
        },
      ];
    })
    .sort((a, b) => a.start - b.start);
}
const depth = z.object({ price: num, quantity: num });
const quoteSchema = z.object({
  instrument_token: z.string(),
  last_price: num,
  timestamp: z.string(),
  last_trade_time: timestamp,
  volume: num.optional(),
  oi: num.optional(),
  previous_oi: num.optional(),
  depth: z.object({ buy: z.array(depth), sell: z.array(depth) }).optional(),
});
export function normalizeRestQuote(raw: unknown, receivedAt: number): Quote {
  const r = quoteSchema.parse(raw),
    sourceTs = Date.parse(r.timestamp);
  if (!Number.isFinite(sourceTs)) throw new Error('Invalid broker quote timestamp');
  const bid = r.depth?.buy[0],
    ask = r.depth?.sell[0],
    isIndex = r.instrument_token.startsWith('NSE_INDEX|');
  return {
    id: `${r.instrument_token}:${sourceTs}:${receivedAt}`,
    instrumentKey: r.instrument_token,
    ltp: r.last_price,
    bid: bid && bid.price > 0 ? bid.price : null,
    ask: ask && ask.price > 0 ? ask.price : null,
    bidQty: bid?.quantity ?? 0,
    askQty: ask?.quantity ?? 0,
    cumulativeVolume: isIndex ? null : (r.volume ?? null),
    oi: r.oi ?? null,
    previousOi: r.previous_oi ?? null,
    oiAsOf: null,
    delta: null,
    gamma: null,
    theta: null,
    iv: null,
    sourceTs,
    receivedAt,
    lastTradeTs: r.last_trade_time,
    mode: 'live',
    quality: ['OI_UPDATE_TIMESTAMP_UNAVAILABLE'],
  };
}
const optionMarket = z.object({
  ltp: num,
  volume: num,
  oi: num,
  bid_price: num,
  bid_qty: num,
  ask_price: num,
  ask_qty: num,
  prev_oi: num.optional(),
});
const greeks = z.object({
  delta: num.optional(),
  gamma: num.optional(),
  theta: num.optional(),
  iv: num.optional(),
});
const optionLeg = z.object({ instrument_key: z.string(), market_data: optionMarket, option_greeks: greeks });
const chainRow = z.object({
  expiry: z.string(),
  strike_price: num,
  underlying_key: z.string(),
  call_options: optionLeg.optional(),
  put_options: optionLeg.optional(),
});
export function normalizeChain(raw: unknown, receivedAt: number): Quote[] {
  return z
    .array(chainRow)
    .parse(raw)
    .flatMap((row) =>
      [row.call_options, row.put_options]
        .filter((l): l is z.infer<typeof optionLeg> => l !== undefined)
        .map((leg) => ({
          id: `chain:${leg.instrument_key}:${receivedAt}`,
          instrumentKey: leg.instrument_key,
          ltp: leg.market_data.ltp,
          bid: leg.market_data.bid_price || null,
          ask: leg.market_data.ask_price || null,
          bidQty: leg.market_data.bid_qty,
          askQty: leg.market_data.ask_qty,
          cumulativeVolume: leg.market_data.volume,
          oi: leg.market_data.oi,
          previousOi: leg.market_data.prev_oi ?? null,
          oiAsOf: null,
          delta: leg.option_greeks.delta ?? null,
          gamma: leg.option_greeks.gamma ?? null,
          theta: leg.option_greeks.theta ?? null,
          iv: leg.option_greeks.iv ?? null,
          sourceTs: 0,
          lastTradeTs: 0,
          receivedAt,
          mode: 'live' as const,
          quality: ['CHAIN_SOURCE_TIMESTAMP_UNAVAILABLE', 'OI_UPDATE_TIMESTAMP_UNAVAILABLE'],
        })),
    );
}
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Upstox ${code} (${status})`);
  }
}
export class UpstoxProvider {
  private nextRequest = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private config: Config,
    private transport: typeof fetch = fetch,
  ) {}
  private async throttle() {
    const wait = Math.max(0, this.nextRequest - Date.now());
    this.nextRequest = Math.max(this.nextRequest, Date.now()) + 1000 / this.config.UPSTOX_REQUESTS_PER_SECOND;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  }
  private async request(path: string, params: Record<string, string> = {}): Promise<unknown> {
    // Only explicitly implemented GET endpoints can reach the broker. There is no order client.
    const url = new URL(path, 'https://api.upstox.com');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 4; attempt++) {
      const reserved = this.queue.then(() => this.throttle());
      this.queue = reserved.catch(() => {});
      await reserved;
      let response: Response;
      try {
        response = await this.transport(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.config.UPSTOX_ANALYTICS_TOKEN}`,
          },
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
      } catch {
        if (attempt === 3) throw new ProviderError(0, 'NETWORK_UNAVAILABLE');
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const retry = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await new Promise((r) =>
          setTimeout(
            r,
            Math.min(30000, Math.max(500 * 2 ** attempt, Number.isFinite(retry) ? retry * 1000 : 0)),
          ),
        );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(
          response.status,
          response.status === 401 ? 'TOKEN_REJECTED' : 'REQUEST_FAILED',
        );
      }
      const envelope = z
        .object({ status: z.literal('success'), data: z.unknown() })
        .parse(await response.json());
      return envelope.data;
    }
    throw new ProviderError(503, 'RETRIES_EXHAUSTED');
  }
  async instruments(): Promise<Instrument[]> {
    const response = await this.transport(
      'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
      { signal: AbortSignal.timeout(30000), redirect: 'error' },
    );
    if (!response.ok) throw new ProviderError(response.status, 'MASTER_UNAVAILABLE');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 50_000_000) throw new Error('Instrument master too large');
    const raw: unknown = JSON.parse(gunzipSync(bytes, { maxOutputLength: 150_000_000 }).toString('utf8'));
    const asOf = Date.now();
    return z
      .array(z.unknown())
      .parse(raw)
      .map((r) => normalizeInstrument(r, asOf))
      .filter((i): i is Instrument => i !== null);
  }
  async contracts(key: string, expiry?: string): Promise<Instrument[]> {
    const data = await this.request('/v2/option/contract', {
      instrument_key: key,
      ...(expiry ? { expiry_date: expiry } : {}),
    });
    return z
      .array(z.unknown())
      .parse(data)
      .map((r) => normalizeInstrument(r, Date.now()))
      .filter((r): r is Instrument => r !== null);
  }
  async chain(key: string, expiry: string): Promise<Quote[]> {
    return normalizeChain(
      await this.request('/v2/option/chain', { instrument_key: key, expiry_date: expiry }),
      Date.now(),
    );
  }
  async quotes(keys: string[]): Promise<Quote[]> {
    if (keys.length === 0) return [];
    if (keys.length > 500) throw new Error('Quote batch exceeds 500');
    const data = z
      .record(z.string(), z.unknown())
      .parse(await this.request('/v3/market-quote/quotes', { instrument_key: keys.join(',') }));
    return Object.values(data).map((r) => normalizeRestQuote(r, Date.now()));
  }
  async historical(key: string, from: string, to: string, interval = 1): Promise<Candle[]> {
    const unit = interval === 1440 ? 'days' : 'minutes',
      n = interval === 1440 ? 1 : interval;
    return normalizeCandles(
      await this.request(`/v3/historical-candle/${encodeURIComponent(key)}/${unit}/${n}/${to}/${from}`),
      key,
      interval,
      Date.now(),
    );
  }
  async historyWindow(key: string, from: string, to: string, interval = 1): Promise<Candle[]> {
    const out: Candle[] = [];
    for (let start = from; start <= to; start = addDays(start, 28)) {
      const end = addDays(start, 27) < to ? addDays(start, 27) : to;
      out.push(...(await this.historical(key, start, end, interval)));
    }
    return out;
  }
  async intraday(key: string, interval = 1): Promise<Candle[]> {
    return normalizeCandles(
      await this.request(`/v3/historical-candle/intraday/${encodeURIComponent(key)}/minutes/${interval}`),
      key,
      interval,
      Date.now(),
      'upstox-v3-intraday',
    );
  }
  async session(day: string): Promise<MarketSession> {
    const rows = z
      .array(z.object({ exchange: z.string(), start_time: timestamp, end_time: timestamp }))
      .parse(await this.request(`/v2/market/timings/${day}`));
    const session = rows.find((r) => r.exchange === 'NFO');
    return {
      id: day,
      day,
      open: session?.start_time ?? atIST(day, '09:15'),
      close: session?.end_time ?? atIST(day, '15:30'),
      trading: !!session,
      verified: true,
      source: 'upstox-market-timings-NFO',
      receivedAt: Date.now(),
    };
  }
  async authorizeFeed(): Promise<string> {
    const r = z
      .object({ authorized_redirect_uri: z.string().url() })
      .parse(await this.request('/v3/feed/market-data-feed/authorize'));
    const u = new URL(r.authorized_redirect_uri);
    if (u.protocol !== 'wss:' || !u.hostname.endsWith('.upstox.com'))
      throw new Error('Untrusted feed destination');
    return r.authorized_redirect_uri;
  }
  async news(keys: string[]): Promise<NewsItem[]> {
    const result: NewsItem[] = [];
    const schema = z.record(
      z.string(),
      z.array(z.object({ heading: z.string(), article_link: z.string().url(), published_time: timestamp })),
    );
    for (let offset = 0; offset < keys.length; offset += 30) {
      const data = schema.parse(
        await this.request('/v2/news', {
          category: 'instrument_keys',
          instrument_keys: keys.slice(offset, offset + 30).join(','),
          page_size: '100',
          page_number: '1',
        }),
      );
      for (const [key, items] of Object.entries(data))
        for (const item of items)
          result.push({
            id: createHash('sha256').update(item.article_link).digest('hex'),
            headline: item.heading,
            url: item.article_link,
            source: 'upstox-news',
            publishedAt: item.published_time,
            receivedAt: Date.now(),
            instrumentKeys: [key],
            classification: 'GENERAL',
            sentiment: null,
            sentimentMethod: null,
            official: false,
            mode: 'live',
          });
    }
    return result;
  }
}
