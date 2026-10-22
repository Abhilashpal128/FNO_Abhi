import { createHash } from 'node:crypto';
import { z } from 'zod';
import Parser from 'rss-parser';
import type { NewsItem } from '../domain.js';
import type { Config } from '../config.js';
export function canonicalNewsUrl(text: string): string {
  const u = new URL(text);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new Error('Invalid news URL');
  u.hash = '';
  for (const k of [...u.searchParams.keys()])
    if (k.startsWith('utm_') || ['fbclid', 'gclid'].includes(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  return u.href;
}
export function officialNewsSource(feedUrl: string, articleUrl: string): boolean {
  const trusted = (host: string) =>
    [
      'nseindia.com',
      'www.nseindia.com',
      'nsearchives.nseindia.com',
      'archives.nseindia.com',
      'rbi.org.in',
      'www.rbi.org.in',
      'rbidocs.rbi.org.in',
    ].includes(host);
  try {
    const f = new URL(feedUrl),
      a = new URL(articleUrl);
    return f.protocol === 'https:' && a.protocol === 'https:' && trusted(f.hostname) && trusted(a.hostname);
  } catch {
    return false;
  }
}
export function newsRecord(
  headline: string,
  url: string,
  publishedAt: number,
  receivedAt: number,
  source: string,
  summary = '',
): NewsItem | null {
  if (
    !headline.trim() ||
    !Number.isFinite(publishedAt) ||
    publishedAt <= 0 ||
    publishedAt > receivedAt ||
    receivedAt - publishedAt > 7 * 86400000
  )
    return null;
  try {
    url = canonicalNewsUrl(url);
  } catch {
    return null;
  }
  return {
    id: createHash('sha256').update(url).digest('hex'),
    headline: headline.slice(0, 1000),
    summary: summary.slice(0, 2000),
    url,
    source,
    publishedAt,
    receivedAt,
    instrumentKeys: [],
    sectors: [],
    classification: 'GENERAL',
    sentiment: null,
    sentimentMethod: null,
    official: false,
    mode: 'live',
  };
}
export class AdditionalNewsProvider {
  constructor(
    private config: Config,
    private transport: typeof fetch = fetch,
  ) {}
  private async json(url: URL, headers: Record<string, string> = {}) {
    const response = await this.transport(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('News provider unavailable');
    return response.json() as Promise<unknown>;
  }
  async gnews(): Promise<NewsItem[]> {
    if (!this.config.GNEWS_API_KEY) return [];
    const url = new URL('https://gnews.io/api/v4/search');
    for (const [k, v] of Object.entries({
      q: this.config.NEWS_SEARCH_QUERY,
      lang: 'en',
      country: 'in',
      max: '10',
      apikey: this.config.GNEWS_API_KEY,
    }))
      url.searchParams.set(k, v);
    const rows = z
      .object({
        articles: z.array(
          z.object({
            title: z.string(),
            url: z.url(),
            publishedAt: z.string(),
            description: z.string().nullable().optional(),
          }),
        ),
      })
      .parse(await this.json(url));
    return rows.articles.flatMap((r) => {
      const n = newsRecord(
        r.title,
        r.url,
        Date.parse(r.publishedAt),
        Date.now(),
        'gnews',
        r.description ?? '',
      );
      return n ? [n] : [];
    });
  }
  async newsapi(): Promise<NewsItem[]> {
    if (!this.config.NEWSAPI_KEY) return [];
    const url = new URL('https://newsapi.org/v2/everything');
    for (const [k, v] of Object.entries({
      q: this.config.NEWS_SEARCH_QUERY,
      language: 'en',
      sortBy: 'publishedAt',
      pageSize: '30',
      searchIn: 'title,description',
    }))
      url.searchParams.set(k, v);
    const rows = z
      .object({
        status: z.literal('ok'),
        articles: z.array(
          z.object({
            title: z.string().nullable(),
            url: z.url(),
            publishedAt: z.string(),
            description: z.string().nullable(),
          }),
        ),
      })
      .parse(await this.json(url, { 'X-Api-Key': this.config.NEWSAPI_KEY }));
    return rows.articles.flatMap((r) => {
      const n = newsRecord(
        r.title ?? '',
        r.url,
        Date.parse(r.publishedAt),
        Date.now(),
        'newsapi',
        r.description ?? '',
      );
      return n ? [n] : [];
    });
  }
  async rss(url: string): Promise<NewsItem[]> {
    const source = new URL(url);
    if (source.protocol !== 'https:') throw new Error('RSS requires HTTPS');
    const response = await this.transport(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('RSS unavailable');
    const text = await response.text();
    if (Buffer.byteLength(text) > 2000000) throw new Error('RSS body too large');
    const feed = await new Parser().parseString(text),
      now = Date.now();
    return feed.items.slice(0, this.config.NEWS_MAX_ITEMS).flatMap((i) => {
      if (!i.link) return [];
      const n = newsRecord(
        i.title ?? '',
        i.link,
        Date.parse(i.isoDate ?? i.pubDate ?? ''),
        now,
        source.hostname,
        i.contentSnippet ?? '',
      );
      if (n) n.official = officialNewsSource(url, i.link);
      return n ? [n] : [];
    });
  }
}
