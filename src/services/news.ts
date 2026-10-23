import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { Store } from '../db/store.js';
import { ConflictError } from '../db/store.js';
import type { Config } from '../config.js';
import type { NewsItem, MarketEvent } from '../domain.js';
import type { UpstoxProvider } from '../providers/upstox.js';
import { dayKey } from '../market/time.js';
import { atIST } from '../market/time.js';
import { AdditionalNewsProvider, canonicalNewsUrl } from '../providers/news.js';
import { createBriefing, clusterNews } from './briefing.js';
function classify(headline: string): NewsItem['classification'] {
  if (/earnings|quarter|results|profit/i.test(headline)) return 'EARNINGS';
  if (/rbi|rate|policy|inflation|budget/i.test(headline)) return 'POLICY';
  if (/merger|acqui|dividend|split|board/i.test(headline)) return 'CORPORATE';
  return 'GENERAL';
}
const sentimentUrlConfigured = (c: Config) => Boolean(c.FINBERT_SERVICE_URL || c.FINBERT_URL);
export function eligibleNews(items: NewsItem[], asOf: number, maxAge = 86400000): NewsItem[] {
  return items.filter((n) => n.publishedAt <= asOf && n.receivedAt <= asOf && asOf - n.publishedAt <= maxAge);
}
export class NewsService {
  private collecting: Promise<void> | null = null;
  private briefing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCollection = 0;
  calendarReady = false;
  private calendarValidUntil = 0;
  constructor(
    private store: Store,
    private config: Config,
    private provider: UpstoxProvider | null,
    private transport: typeof fetch = fetch,
  ) {}
  async collect(keys: string[], now = Date.now()): Promise<void> {
    const extra = new AdditionalNewsProvider(this.config, this.transport);
    const jobs: { name: string; run: () => Promise<NewsItem[]> }[] = [];
    if (this.provider) jobs.push({ name: 'upstox-news', run: () => this.provider!.news(keys) });
    if (this.config.GNEWS_API_KEY) jobs.push({ name: 'gnews', run: () => extra.gnews() });
    if (this.config.NEWSAPI_KEY) jobs.push({ name: 'newsapi', run: () => extra.newsapi() });
    for (const [i, url] of [
      ...new Set(
        [...this.config.RSS_FEED_URLS, this.config.NSE_RSS_URL, this.config.RBI_RSS_URL].filter(Boolean),
      ),
    ].entries())
      jobs.push({ name: `rss-${i}`, run: () => extra.rss(url) });
    const incoming: NewsItem[] = [];
    const results = await Promise.allSettled(jobs.map((j) => j.run()));
    for (const [i, result] of results.entries()) {
      await this.store.put('system_health', {
        id: `source:${jobs[i]!.name}`,
        status: result.status === 'fulfilled' ? 'OK' : 'UNAVAILABLE',
        checkedAt: Date.now(),
        details: result.status === 'fulfilled' ? [] : ['Provider failed; no substitute data'],
      });
      if (result.status === 'fulfilled') incoming.push(...result.value);
    }
    const instruments = await this.store.find('instruments', {
      kind: { $in: ['INDEX', 'EQUITY'] },
      active: true,
    });
    const deduplicated = new Map<string, NewsItem>();
    for (const n of incoming) {
      if (
        !Number.isFinite(n.publishedAt) ||
        !Number.isFinite(n.receivedAt) ||
        n.publishedAt > n.receivedAt ||
        n.receivedAt > Math.max(now, Date.now())
      )
        continue;
      try {
        n.url = canonicalNewsUrl(n.url);
      } catch {
        continue;
      }
      n.id = createHash('sha256').update(n.url).digest('hex');
      const previous = deduplicated.get(n.id);
      deduplicated.set(n.id, {
        ...n,
        instrumentKeys: [...new Set([...(previous?.instrumentKeys ?? []), ...n.instrumentKeys])],
      });
    }
    const selected = [...deduplicated.values()]
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, this.config.NEWS_MAX_ITEMS);
    const clusters = clusterNews(selected);
    for (const n of selected) {
      const old = await this.store.get('market_news', n.id);
      if (old) {
        continue;
      }
      n.classification = classify(n.headline);
      for (const i of instruments) {
        const alias = i.name.trim().toLowerCase();
        if (alias.length >= 5 && n.headline.toLowerCase().includes(alias)) {
          n.instrumentKeys.push(i.id);
          if (i.sector) n.sectors = [...new Set([...(n.sectors ?? []), i.sector])];
        }
      }
      n.instrumentKeys = [...new Set(n.instrumentKeys)];
      n.clusterId = clusters.find((c) => c.sourceIds.includes(n.id))?.id;
      const sentimentUrl = this.config.FINBERT_SERVICE_URL || this.config.FINBERT_URL;
      n.sentiment = null;
      n.sentimentMethod = null;
      if (this.config.AI_ENABLED && this.config.FINBERT_ENABLED && sentimentUrl) {
        try {
          const response = await this.transport(sentimentUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: n.headline }),
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          });
          if (response.ok) {
            const sentiment = z
              .object({ label: z.enum(['positive', 'negative', 'neutral']), modelVersion: z.string() })
              .parse(await response.json());
            n.sentiment = sentiment.label;
            n.sentimentMethod = sentiment.modelVersion;
          }
        } catch {
          /* Optional service outage never becomes a fake neutral prediction. */
        }
      }
      // A newly enriched headline is not usable before collection and inference finish.
      n.receivedAt = Math.max(n.receivedAt, Date.now());
      await this.store.put('market_news', n);
    }
    await this.store.put('system_health', {
      id: 'news-models',
      status:
        !this.config.AI_ENABLED || (!this.config.FINBERT_ENABLED && !this.config.QWEN_ENABLED)
          ? 'DISABLED'
          : selected.some((n) => n.sentiment !== null)
            ? 'OK'
            : 'DEGRADED',
      checkedAt: Date.now(),
      details: !this.config.AI_ENABLED
        ? ['AI_DISABLED; source news collection remains active']
        : [
            ...(!sentimentUrlConfigured(this.config)
              ? ['FINBERT_NOT_CONFIGURED']
              : selected.some((n) => n.sentiment === null)
                ? ['FINBERT_PARTIALLY_UNAVAILABLE']
                : []),
            ...(!this.config.OLLAMA_BASE_URL ? ['OLLAMA_NOT_CONFIGURED'] : []),
          ],
    });
  }
  backgroundCollect(keys: string[]) {
    if (this.collecting) return;
    this.collecting = this.collect(keys)
      .catch(async () => {
        await this.store.put('system_health', {
          id: 'news-worker',
          status: 'UNAVAILABLE',
          checkedAt: Date.now(),
          details: ['News collection failed'],
        });
      })
      .catch(() => {
        /* Database outage is visible through database health. Keep the worker retryable. */
      })
      .finally(() => {
        this.collecting = null;
      });
  }
  scheduleBriefing(cutoff: number) {
    if (this.briefing) return;
    this.briefing = (async () => {
      if ((await this.store.find('news_briefings', { cutoff }, { limit: 1 })).length) return;
      const items = await this.store.find(
        'market_news',
        { publishedAt: { $lte: cutoff }, receivedAt: { $lte: cutoff } },
        { sort: { publishedAt: -1 }, limit: this.config.NEWS_MAX_ITEMS },
      );
      const brief = await createBriefing(items, cutoff, Date.now(), this.config, this.transport);
      // Availability includes inference time; the source cutoff stays fixed at 09:00.
      brief.createdAt = Date.now();
      await this.store.insertMany('news_briefings', [brief]);
    })()
      .catch(async () => {
        await this.store.put('system_health', {
          id: 'briefing',
          status: 'UNAVAILABLE',
          checkedAt: Date.now(),
          details: ['Briefing failed; retry on next worker cycle'],
        });
      })
      .catch(() => {
        /* Database outage is visible through database health. */
      })
      .finally(() => {
        this.briefing = null;
      });
  }
  start(keys: () => string[]) {
    if (this.config.DATA_MODE !== 'live' || this.timer) return;
    const tick = () => {
      const now = Date.now(),
        day = dayKey(now),
        cutoff = atIST(day, '09:00');
      if (
        now >= atIST(day, '08:30') &&
        now <= atIST(day, '16:00') &&
        now - this.lastCollection >= 5 * 60000
      ) {
        this.backgroundCollect(keys());
        this.lastCollection = now;
      }
      // Leave the configured inference timeout plus one worker tick before the 09:00 deadline.
      // A late startup still records actual availability rather than backdating the report.
      const lead =
        this.config.AI_ENABLED && this.config.QWEN_ENABLED ? this.config.NEWS_MODEL_TIMEOUT_MS + 30000 : 0;
      if (now >= cutoff - lead) this.scheduleBriefing(cutoff);
    };
    this.timer = setInterval(tick, 30000);
    tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.collecting;
    await this.briefing;
  }
  async loadEvents(now = Date.now()): Promise<void> {
    this.calendarReady = false;
    if (!this.config.EVENT_CALENDAR_PATH && !this.config.EVENT_CALENDAR_JSON) return;
    const schema = z.object({
      validFrom: z.iso.date(),
      validUntil: z.iso.date(),
      source: z.string().min(1),
      events: z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          start: z.number().int().positive(),
          end: z.number().int().positive(),
          instrumentKeys: z.array(z.string()),
          impact: z.enum(['HIGH', 'MEDIUM', 'LOW']),
          publishedAt: z.number().int().positive(),
        }),
      ),
    });
    const file = schema.parse(
      JSON.parse(
        this.config.EVENT_CALENDAR_JSON || (await readFile(this.config.EVENT_CALENDAR_PATH, 'utf8')),
      ),
    );
    const today = dayKey(now);
    if (file.validFrom > today || file.validUntil < today) return;
    const records: MarketEvent[] = [];
    for (const event of file.events) {
      if (event.end < event.start || event.publishedAt > now)
        throw new Error('Invalid event calendar interval');
      const record: MarketEvent = { ...event, source: file.source, receivedAt: now };
      records.push(record);
      await this.store.put('market_events', record);
    }
    const versionId = `${now}:${createHash('sha256').update(JSON.stringify(file)).digest('hex')}`;
    if (!(await this.store.get('event_calendar_versions', versionId)))
      try {
        await this.store.insert('event_calendar_versions', {
          id: versionId,
          validFrom: file.validFrom,
          validUntil: file.validUntil,
          source: file.source,
          receivedAt: now,
          events: records,
        });
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    this.calendarValidUntil = Date.parse(`${file.validUntil}T23:59:59+05:30`);
    this.calendarReady = true;
  }
  isCalendarReady(now: number) {
    return this.calendarReady && now <= this.calendarValidUntil;
  }
  async context(key: string, asOf: number) {
    const items = eligibleNews(
      await this.store.find(
        'market_news',
        { publishedAt: { $lte: asOf }, receivedAt: { $lte: asOf } },
        { sort: { publishedAt: -1 }, limit: 500 },
      ),
      asOf,
    )
      .filter((n) => n.instrumentKeys.includes(key) || n.classification === 'POLICY')
      .map((n) =>
        this.config.AI_ENABLED && this.config.FINBERT_ENABLED
          ? n
          : { ...n, sentiment: null, sentimentMethod: null },
      );
    const version = (
      await this.store.find(
        'event_calendar_versions',
        { receivedAt: { $lte: asOf }, validFrom: { $lte: dayKey(asOf) }, validUntil: { $gte: dayKey(asOf) } },
        { sort: { receivedAt: -1 }, limit: 1 },
      )
    )[0];
    const events = (version?.events ?? []).filter(
      (e) =>
        e.publishedAt <= asOf &&
        e.receivedAt <= asOf &&
        e.start <= asOf + 30 * 60000 &&
        e.end >= asOf &&
        (e.instrumentKeys.length === 0 || e.instrumentKeys.includes(key)),
    );
    return {
      items,
      events,
      highImpact: events.some((e) => e.impact === 'HIGH'),
      conflicting:
        items.some((n) => n.sentiment === 'positive') && items.some((n) => n.sentiment === 'negative'),
    };
  }
}
