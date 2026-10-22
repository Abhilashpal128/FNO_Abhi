import WebSocket from 'ws';
import protobuf from 'protobufjs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Quote, Candle } from '../domain.js';
import type { Config } from '../config.js';
import type { UpstoxProvider } from './upstox.js';
import { z } from 'zod';
import { candleId } from '../market/candles.js';
const n = z.coerce.number().finite(),
  ltpc = z.object({ ltp: n, ltt: n });
const ohlc = z.object({ interval: z.string(), open: n, high: n, low: n, close: n, vol: n.optional(), ts: n });
const ff = z.object({
  ltpc,
  marketLevel: z
    .object({
      bidAskQuote: z.array(
        z.object({ bidP: n.optional(), askP: n.optional(), bidQ: n.optional(), askQ: n.optional() }),
      ),
    })
    .optional(),
  optionGreeks: z.object({ delta: n.optional(), gamma: n.optional(), theta: n.optional() }).optional(),
  marketOHLC: z.object({ ohlc: z.array(ohlc) }).optional(),
  vtt: n.optional(),
  oi: n.optional(),
  iv: n.optional(),
});
const frame = z.object({
  currentTs: n.optional(),
  feeds: z
    .record(
      z.string(),
      z.object({ fullFeed: z.object({ marketFF: ff.optional(), indexFF: ff.optional() }).optional() }),
    )
    .optional(),
});
export function normalizeFeed(raw: unknown, receivedAt: number): { quotes: Quote[]; candles: Candle[] } {
  const f = frame.parse(raw),
    quotes: Quote[] = [],
    candles: Candle[] = [];
  if (!f.currentTs) return { quotes, candles };
  for (const [key, entry] of Object.entries(f.feeds ?? {})) {
    const market = entry.fullFeed?.marketFF,
      index = entry.fullFeed?.indexFF,
      value = market ?? index;
    if (!value) continue;
    const depth = market?.marketLevel?.bidAskQuote[0],
      greeks = market?.optionGreeks,
      sourceTs = f.currentTs;
    quotes.push({
      id: `${key}:${sourceTs}:${receivedAt}`,
      instrumentKey: key,
      ltp: value.ltpc.ltp,
      bid: depth?.bidP && depth.bidP > 0 ? depth.bidP : null,
      ask: depth?.askP && depth.askP > 0 ? depth.askP : null,
      bidQty: depth?.bidQ ?? 0,
      askQty: depth?.askQ ?? 0,
      cumulativeVolume: index ? null : (market?.vtt ?? null),
      oi: market?.oi ?? null,
      previousOi: null,
      oiAsOf: null,
      delta: greeks?.delta ?? null,
      gamma: greeks?.gamma ?? null,
      theta: greeks?.theta ?? null,
      iv: market?.iv ?? null,
      sourceTs,
      receivedAt,
      lastTradeTs: value.ltpc.ltt,
      mode: 'live',
      quality: ['OI_UPDATE_TIMESTAMP_UNAVAILABLE'],
    });
    for (const c of value.marketOHLC?.ohlc ?? []) {
      const interval = c.interval === 'I1' ? 1 : c.interval === 'I30' ? 30 : null;
      if (interval === null) continue;
      const end = c.ts + interval * 60000;
      if (end > sourceTs || end > receivedAt) continue;
      if (
        c.open <= 0 ||
        c.close <= 0 ||
        c.low <= 0 ||
        c.high < Math.max(c.open, c.close, c.low) ||
        c.low > Math.min(c.open, c.close) ||
        (c.vol !== undefined && c.vol < 0)
      )
        continue;
      candles.push({
        id: candleId(key, interval, c.ts),
        instrumentKey: key,
        interval,
        start: c.ts,
        end,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: index ? null : (c.vol ?? null),
        oi: null,
        complete: true,
        quality: [],
        source: 'upstox-v3-exchange-ohlc',
        receivedAt,
        mode: 'live',
      });
    }
  }
  return { quotes, candles };
}
export class MarketFeed {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private keys: string[] = [];
  private stopped = true;
  private attempt = 0;
  private lastMessage = 0;
  private decoder: protobuf.Type | null = null;
  private connecting = false;
  constructor(
    private provider: UpstoxProvider,
    private config: Config,
    private log: Logger,
    private onData: (data: { quotes: Quote[]; candles: Candle[] }) => void,
    private onReconnect: () => void,
  ) {}
  async start(keys: string[]) {
    this.keys = [...new Set(keys)].slice(0, this.config.MAX_SUBSCRIPTIONS);
    this.decoder = (await protobuf.load(resolve('proto/MarketDataFeed.proto'))).lookupType(
      'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse',
    );
    this.stopped = false;
    await this.connect();
    this.heartbeat = setInterval(() => {
      if (this.socket && Date.now() - this.lastMessage > this.config.FEED_HEARTBEAT_MS * 2)
        this.socket.terminate();
    }, this.config.FEED_HEARTBEAT_MS);
  }
  updateSubscriptions(prioritized: string[]) {
    const next = [...new Set(prioritized)].slice(0, this.config.MAX_SUBSCRIPTIONS);
    const removed = this.keys.filter((k) => !next.includes(k)),
      added = next.filter((k) => !this.keys.includes(k));
    this.keys = next;
    this.send('unsub', removed);
    this.send('sub', added);
  }
  private send(method: 'sub' | 'unsub', keys: string[]) {
    if (keys.length && this.socket?.readyState === WebSocket.OPEN)
      this.socket.send(
        Buffer.from(
          JSON.stringify({ guid: randomUUID(), method, data: { mode: 'full', instrumentKeys: keys } }),
        ),
        { binary: true },
      );
  }
  private async connect() {
    if (this.stopped || this.connecting) return;
    this.connecting = true;
    try {
      const url = await this.provider.authorizeFeed();
      if (this.stopped) return;
      const ws = new WebSocket(url, { handshakeTimeout: 15000, maxPayload: 8 * 1024 * 1024 });
      this.socket = ws;
      ws.on('open', () => {
        this.attempt = 0;
        this.lastMessage = Date.now();
        this.send('sub', this.keys);
        this.onReconnect();
      });
      ws.on('ping', () => {
        this.lastMessage = Date.now();
      });
      ws.on('message', (data) => {
        this.lastMessage = Date.now();
        try {
          const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
          const decoded = this.decoder!.toObject(this.decoder!.decode(bytes), {
            longs: Number,
            enums: String,
            defaults: false,
          });
          this.onData(normalizeFeed(decoded, Date.now()));
        } catch {
          this.log.warn({ component: 'feed' }, 'Rejected malformed market frame');
        }
      });
      ws.on('error', () => {
        this.log.warn({ component: 'feed' }, 'Market socket error');
        ws.terminate();
      });
      ws.on('close', () => {
        if (this.socket === ws) this.socket = null;
        this.retry();
      });
    } catch {
      this.log.warn({ component: 'feed' }, 'Feed authorization unavailable');
      this.retry();
    } finally {
      this.connecting = false;
    }
  }
  private retry() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(this.attempt++, 6)) + Math.random() * 500;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, delay);
  }
  status() {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      lastMessageAt: this.lastMessage || null,
      subscriptions: this.keys.length,
    };
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    this.socket = null;
  }
}
