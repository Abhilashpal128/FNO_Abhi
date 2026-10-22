import { describe, it, expect } from 'vitest';
import protobuf from 'protobufjs';
import { normalizeFeed } from '../src/providers/feed.js';
import { UpstoxProvider, normalizeRestQuote } from '../src/providers/upstox.js';
import { configSchema } from '../src/config.js';
import { DEMO_NOW } from '../src/testing/demo.js';
const config = configSchema.parse({
  APP_PASSWORD_HASH: 'x'.repeat(64),
  JWT_SECRET: 't'.repeat(64),
  UPSTOX_ANALYTICS_TOKEN: 'fixture-token',
});
describe('verified Upstox wire adapters', () => {
  it('accepts actual V3 index null volume/OI without fabricating zero participation', () => {
    const quote = normalizeRestQuote({ instrument_token: 'NSE_INDEX|Nifty 50', last_price: 25000,
      timestamp: new Date(DEMO_NOW).toISOString(), last_trade_time: String(DEMO_NOW - 60000),
      volume: null, oi: null, previous_oi: null, depth: null,
    }, DEMO_NOW);
    expect(quote.cumulativeVolume).toBeNull();
    expect(quote.oi).toBeNull();
    expect(quote.previousOi).toBeNull();
    expect(quote.bid).toBeNull();
  });
  it('decodes official V3 protobuf and preserves absent fields as null', async () => {
    const root = await protobuf.load('proto/MarketDataFeed.proto'),
      type = root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');
    const raw = {
      currentTs: DEMO_NOW,
      feeds: {
        'NSE_FO|123': {
          fullFeed: {
            marketFF: {
              ltpc: { ltp: 100, ltt: DEMO_NOW },
              vtt: 1000,
              oi: 500,
              iv: 20,
              marketLevel: { bidAskQuote: [{ bidP: 99.9, askP: 100, bidQ: 200, askQ: 200 }] },
              optionGreeks: { delta: 0.5, gamma: 0.01, theta: -1 },
            },
          },
        },
        'NSE_INDEX|Nifty 50': { fullFeed: { indexFF: { ltpc: { ltp: 25000, ltt: DEMO_NOW } } } },
      },
    };
    const wire = type.encode(type.create(raw)).finish();
    const result = normalizeFeed(
      type.toObject(type.decode(wire), { longs: Number, enums: String }),
      DEMO_NOW,
    );
    expect(result.quotes[0]?.cumulativeVolume).toBe(1000);
    expect(result.quotes[0]?.delta).toBe(0.5);
    expect(result.quotes[1]?.cumulativeVolume).toBeNull();
    expect(result.quotes[0]?.oiAsOf).toBeNull();
  });
  it('does not emit incomplete exchange OHLC as completed bars', () => {
    const result = normalizeFeed(
      {
        currentTs: DEMO_NOW,
        feeds: {
          'NSE_FO|1': {
            fullFeed: {
              marketFF: {
                ltpc: { ltp: 100, ltt: DEMO_NOW },
                marketOHLC: {
                  ohlc: [
                    {
                      interval: 'I1',
                      ts: DEMO_NOW - 10000,
                      open: 100,
                      high: 102,
                      low: 99,
                      close: 101,
                      vol: 200,
                    },
                  ],
                },
              },
            },
          },
        },
      },
      DEMO_NOW,
    );
    expect(result.candles).toHaveLength(0);
  });
  it('keeps quote generation and last-trade clocks distinct', () => {
    const result = normalizeRestQuote(
      {
        instrument_token: 'NSE_FO|123',
        last_price: 100,
        timestamp: new Date(DEMO_NOW).toISOString(),
        last_trade_time: String(DEMO_NOW - 60000),
        volume: 1000,
        depth: { buy: [{ price: 99, quantity: 100 }], sell: [{ price: 100, quantity: 100 }] },
      },
      DEMO_NOW,
    );
    expect(result.sourceTs - result.lastTradeTs).toBe(60000);
  });
  it('sends GET only and bearer token to the documented market path', async () => {
    let method: string | undefined,
      url = '';
    const transport: typeof fetch = async (input, init) => {
      url = String(input);
      method = init?.method;
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer fixture-token');
      return new Response(
        JSON.stringify({
          status: 'success',
          data: { authorized_redirect_uri: 'wss://feed.upstox.com/test?code=fixture' },
        }),
        { status: 200 },
      );
    };
    const provider = new UpstoxProvider(config, transport);
    await provider.authorizeFeed();
    expect(url).toContain('/v3/feed/market-data-feed/authorize');
    expect(method).toBe('GET');
  });
  it('rejects unauthorized feed destinations and exposes no response body secrets', async () => {
    const bad: typeof fetch = async () =>
      new Response(
        JSON.stringify({ status: 'success', data: { authorized_redirect_uri: 'wss://evil.example/token' } }),
        { status: 200 },
      );
    await expect(new UpstoxProvider(config, bad).authorizeFeed()).rejects.toThrow('Untrusted');
    const denied: typeof fetch = async () => new Response('sensitive broker error response', { status: 401 });
    await expect(new UpstoxProvider(config, denied).quotes(['NSE_FO|1'])).rejects.toThrow('TOKEN_REJECTED');
  });
  it('rejects empty/malformed API envelopes rather than filling synthetic data', async () => {
    const invalid: typeof fetch = async () =>
      new Response(JSON.stringify({ status: 'error', data: {} }), { status: 200 });
    await expect(new UpstoxProvider(config, invalid).quotes(['NSE_FO|1'])).rejects.toThrow();
  });
});
