import type { createRuntime } from '../runtime.js';
import { atIST, dayKey } from '../market/time.js';
import { createBriefing } from './briefing.js';
type Runtime = Awaited<ReturnType<typeof createRuntime>>;

/** Vercel performs bounded work inside authenticated requests. No timer or WebSocket is started. */
export class RequestDataService {
  private tail: Promise<void> = Promise.resolve();
  private universeDay = '';
  private quotesAt = 0;
  private newsAt = 0;
  constructor(private runtime: Runtime) {}
  refresh(path: string, method: string): Promise<void> {
    const job = this.tail.then(() => this.run(path, method));
    this.tail = job.catch(() => {});
    return job;
  }
  private async run(path: string, method: string) {
    const { config, market, news, store, paper, analysis, quality } = this.runtime;
    if (config.DATA_MODE !== 'live') return;
    const now = Date.now(), day = dayKey(now);
    const marketRequest = path.startsWith('/market/') || path === '/analysis/refresh' || path === '/performance' || path.startsWith('/paper-trades');
    const newsRequest = path.startsWith('/news');
    if (!marketRequest && !newsRequest) return;
    if (newsRequest) {
      if (now - this.newsAt >= 5 * 60000) {
        await news.collect(config.UPSTOX_UNDERLYING_KEYS.length ? config.UPSTOX_UNDERLYING_KEYS : ['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank'], now);
        this.newsAt = Date.now();
      }
      if (path === '/news/briefings/latest') {
        const cutoff = atIST(day, '09:00');
        if (now >= cutoff && !(await store.find('news_briefings', { cutoff }, { limit: 1 })).length) {
          const items = await store.find('market_news', { publishedAt: { $lte: cutoff }, receivedAt: { $lte: cutoff } }, { sort: { publishedAt: -1 }, limit: config.NEWS_MAX_ITEMS });
          const brief = await createBriefing(items, cutoff, Date.now(), config);
          await store.insertMany('news_briefings', [brief]);
        }
      }
      return;
    }
    if (path === '/analysis/refresh' && method === 'POST') {
      if (!market.isPrepared(day)) await market.prepare(now, { stream: false });
      else await market.reconcile(now);
      this.universeDay = day;
    }
    if (this.universeDay !== day) {
      await market.loadUniverse(now);
      this.universeDay = day;
    }
    await market.loadSession(now);
    await news.loadEvents(now);
    if (now - this.quotesAt >= 5000 || method !== 'GET') {
      const keys = [...new Set([...market.underlyings.map(i => i.id), ...market.volumeKeys.values(), 'NSE_INDEX|India VIX'])];
      for (const quote of await market.provider!.quotes(keys)) await market.acceptQuote(quote);
      await market.refreshContracts(now);
      for (const trade of await store.find('paper_trades', { status: 'OPEN' })) {
        for (const quote of await market.provider!.quotes([trade.instrumentKey])) await market.acceptQuote(quote);
      }
      this.quotesAt = Date.now();
      for (const quote of market.quotes.values()) {
        await analysis.monitor(quote, Date.now());
        await paper.monitor(quote, Date.now());
      }
      await analysis.expire(Date.now());
      await quality.refresh(Date.now());
      await market.maintenance(Date.now());
    }
  }
}
