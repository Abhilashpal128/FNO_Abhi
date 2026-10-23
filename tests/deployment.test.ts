import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { fixture } from './helpers.js';
import { createApp } from '../src/api/app.js';
import { issueToken } from '../src/api/auth.js';
import { createBriefing } from '../src/services/briefing.js';
import { NewsService } from '../src/services/news.js';
import { ValidatedModelService } from '../src/services/models.js';
import { MarketService } from '../src/services/market.js';
import { UpstoxProvider } from '../src/providers/upstox.js';
import { RequestDataService } from '../src/services/request-data.js';
import { ResearchQualityService } from '../src/services/quality.js';
import { StorageHealthService } from '../src/services/storage.js';
import { configSchema } from '../src/config.js';
import type { NewsItem } from '../src/domain.js';
import { DEMO_NOW, DEMO_DAY } from '../src/testing/demo.js';
import { atIST } from '../src/market/time.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AI-disabled deployment', () => {
  it('does not call configured models when the master switch is off', async () => {
    const s = await fixture();
    const config = {
      ...s.config,
      AI_ENABLED: false,
      QWEN_ENABLED: true,
      FINBERT_ENABLED: true,
      LIGHTGBM_ENABLED: true,
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
      FINBERT_SERVICE_URL: 'http://127.0.0.1:8000/sentiment',
    };
    const now = Date.now();
    const item: NewsItem = {
      id: 'source',
      headline: 'Company publishes quarterly results',
      summary: 'Source supplied summary.',
      url: 'https://www.nseindia.com/announcement/1',
      source: 'nse',
      publishedAt: now - 60000,
      receivedAt: now - 1000,
      instrumentKeys: ['NSE_EQ|TEST'],
      classification: 'EARNINGS',
      sentiment: null,
      sentimentMethod: null,
      official: true,
      mode: 'live',
    };
    const modelTransport = vi.fn<typeof fetch>().mockRejectedValue(new Error('Must not execute'));
    vi.stubGlobal('fetch', modelTransport);
    const provider = new UpstoxProvider(config);
    vi.spyOn(provider, 'news').mockResolvedValue([item]);
    const news = new NewsService(s.store, config, provider, modelTransport);
    await news.collect(item.instrumentKeys);
    expect(
      (await s.store.find('market_news')).some((n) => n.headline === item.headline && n.sentiment === null),
    ).toBe(true);
    expect((await s.store.get('system_health', 'news-models'))?.status).toBe('DISABLED');
    const brief = await createBriefing([item], now, now, config, modelTransport);
    expect(brief).toMatchObject({
      status: 'READY',
      method: 'SOURCE_DIGEST',
      aiStatus: 'DISABLED',
      model: null,
      events: [],
    });
    expect(brief.sources[0]).toMatchObject({ instrumentKeys: item.instrumentKeys, summary: item.summary });
    expect(
      await new ValidatedModelService(s.store, 'http://127.0.0.1:8000/predict', config).predict(
        'model',
        {},
        now,
      ),
    ).toMatchObject({ probability: null, reason: 'AI_DISABLED' });
    expect(modelTransport).not.toHaveBeenCalled();
  });
  it('requires individual opt-in even with AI_ENABLED=true', async () => {
    const s = await fixture();
    const config = { ...s.config, AI_ENABLED: true, OLLAMA_BASE_URL: 'http://127.0.0.1:11434' };
    const transport = vi.fn<typeof fetch>();
    await createBriefing([], DEMO_NOW, DEMO_NOW, config, transport);
    expect(
      await new ValidatedModelService(s.store, 'http://127.0.0.1:8000/predict', config).predict(
        'model',
        {},
        DEMO_NOW,
      ),
    ).toMatchObject({ probability: null, reason: 'AI_DISABLED' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('fails closed on demo production settings and invalid platform ports', async () => {
    const s = await fixture();
    const env = {
      APP_PASSWORD_HASH: s.config.APP_PASSWORD_HASH,
      JWT_SECRET: s.config.JWT_SECRET,
      NODE_ENV: 'production',
      STORAGE_MODE: 'mongo',
      DATA_MODE: 'demo',
    };
    expect(configSchema.safeParse(env).success).toBe(false);
    expect(configSchema.safeParse({ ...env, NODE_ENV: 'test', PORT: '70000' }).success).toBe(false);
    expect(configSchema.parse({ ...env, NODE_ENV: 'test', PORT: '8080' }).HOST).toBe('0.0.0.0');
  });
});

describe('Vercel request lifecycle', () => {
  async function setup() {
    const s = await fixture();
    const config = { ...s.config, DATA_MODE: 'live' as const };
    const provider = new UpstoxProvider(config);
    const market = new MarketService(s.store, config, provider, s.log);
    const quality = new ResearchQualityService(s.store, config);
    const storage = new StorageHealthService(s.store, market, config);
    vi.spyOn(storage, 'check').mockResolvedValue(null);
    vi.spyOn(quality, 'refresh').mockResolvedValue();
    vi.spyOn(market, 'loadUniverse').mockResolvedValue();
    vi.spyOn(market, 'loadSession').mockResolvedValue(null);
    vi.spyOn(market, 'refreshContracts').mockResolvedValue();
    vi.spyOn(market, 'maintenance').mockResolvedValue();
    vi.spyOn(provider, 'quotes').mockResolvedValue([]);
    return { ...s, config, provider, market, quality, storage };
  }
  it('fetches /market once for concurrent warm requests and never opens a feed', async () => {
    const s = await setup();
    const data = new RequestDataService(s);
    await Promise.all([data.refresh('/market', 'GET'), data.refresh('/market', 'GET')]);
    expect(s.market.loadUniverse).toHaveBeenCalledTimes(1);
    expect(s.provider.quotes).toHaveBeenCalledTimes(1);
    expect(s.market.feed).toBeNull();
  });
  it('checks authentication before performing any external data work', async () => {
    const s = await setup(),
      beforeRequest = vi.fn().mockResolvedValue(undefined);
    const app = createApp({ ...s, beforeRequest, runtime: 'vercel' });
    expect((await request(app).get('/api/v1/market')).status).toBe(401);
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(
      (
        await request(app)
          .get('/api/v1/market')
          .auth(await issueToken(s.config), { type: 'bearer' })
      ).status,
    ).toBe(200);
    expect(beforeRequest).toHaveBeenCalledWith('/market', 'GET', {});
  });
  it('reuses collection for an explicit analysis request with streaming disabled', async () => {
    const s = await setup();
    vi.spyOn(s.market, 'prepare').mockResolvedValue();
    await new RequestDataService(s).refresh('/analysis/refresh', 'POST');
    expect(s.market.prepare).toHaveBeenCalledWith(expect.any(Number), { stream: false });
    expect(s.market.feed).toBeNull();
  });
  it('keeps persisted paper results readable when the provider is unavailable', async () => {
    const s = await setup();
    vi.mocked(s.provider.quotes).mockRejectedValue(new Error('provider unavailable'));
    const data = new RequestDataService(s);
    await expect(data.refresh('/market', 'GET')).rejects.toThrow('provider unavailable');
    await expect(data.refresh('/performance', 'GET')).resolves.toBeUndefined();
    await expect(data.refresh('/analysis/history', 'GET')).resolves.toBeUndefined();
  });
  it('rejects an unbounded history request before calling the provider', async () => {
    const s = await setup();
    const history = vi.spyOn(s.provider, 'historyWindow');
    await expect(
      new RequestDataService(s).refresh('/market/candles', 'GET', {
        instrumentKey: 'NSE_EQ|TEST',
        from: 1,
        to: Date.now(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TIME_RANGE' });
    expect(history).not.toHaveBeenCalled();
  });
});

describe('daily completed paper accounting', () => {
  it('uses the IST exit date and excludes open positions and raw signals from the sample', async () => {
    const s = await fixture();
    const run = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW);
    const original = (await s.store.get('trade_signals', run.signalIds[0]!))!;
    const template = await s.paper.open(original.id, 1, 'daily-report', DEMO_NOW);
    const midnight = atIST(DEMO_DAY, '00:00');
    for (const [id, pnl, closedAt, fees] of [
      ['prior', 90, midnight - 1, 10],
      ['win', 40, midnight + 1, 10],
      ['loss', -20, midnight + 2, 12],
    ] as const)
      await s.store.insert('paper_trades', {
        ...template,
        id,
        signalId: id,
        underlyingKey: id,
        requestKey: id,
        status: 'CLOSED',
        closedAt,
        pnl,
        entryFee: fees / 2,
        exitFee: fees / 2,
        exit: template.entry + (pnl + fees) / template.quantity,
      });
    const report = await s.paper.report(DEMO_NOW);
    expect(report.daily).toMatchObject({
      day: DEMO_DAY,
      trades: 2,
      wins: 1,
      losses: 1,
      winRate: 0.5,
      netPnl: 20,
      fees: 22,
    });
    expect(report.daily.grossPnl).toBeCloseTo(42);
    expect(report.metrics.trades).toBe(3);
    expect(report.open).toHaveLength(1);
    expect((await s.store.get('trade_signals', original.id))?.snapshotHash).toBe(original.snapshotHash);
  });
});
