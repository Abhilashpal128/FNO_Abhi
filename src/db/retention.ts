import type { Collection, Collections } from '../domain.js';
import type { Config } from '../config.js';
const DAY = 86400000;
export interface RetentionPolicy {
  minute: number;
  aggregate: number;
  daily: number;
  snapshot: number;
  optionAggregate: number;
  profiles: number;
  news: number;
}
export const defaultRetention: RetentionPolicy = {
  minute: 60,
  aggregate: 365,
  daily: 1095,
  snapshot: 7,
  optionAggregate: 90,
  profiles: 365,
  news: 180,
};
export function retentionPolicy(c: Config): RetentionPolicy {
  return {
    minute: c.CANDLE_MINUTE_RETENTION_DAYS,
    aggregate: c.CANDLE_AGGREGATE_RETENTION_DAYS,
    daily: c.CANDLE_DAILY_RETENTION_DAYS,
    snapshot: c.SNAPSHOT_RETENTION_DAYS,
    optionAggregate: c.OPTION_AGGREGATE_RETENTION_DAYS,
    profiles: c.VOLUME_PROFILE_RETENTION_DAYS,
    news: c.NEWS_RETENTION_DAYS,
  };
}
// Only the market-data/news categories explicitly covered by the requested retention policy.
// Decisions, outcomes, model validations, signals, trades, briefings and health/audit records NEVER expire.
export const expirable = new Set<Collection>([
  'market_candles',
  'market_volume_profiles',
  'option_snapshots',
  'option_aggregates',
  'market_news',
]);
export function automaticExpiry<K extends Collection>(
  name: K,
  value: Collections[K],
  p: RetentionPolicy,
): number | null {
  if (name === 'market_candles') {
    const c = value as Collections['market_candles'];
    return c.interval === 1 ? null : c.end + (c.interval === 1440 ? p.daily : p.aggregate) * DAY;
  }
  if (name === 'market_volume_profiles') {
    const c = value as Collections['market_volume_profiles'];
    return Date.parse(`${c.day}T23:59:59+05:30`) + p.profiles * DAY;
  }
  if (name === 'option_aggregates')
    return (value as Collections['option_aggregates']).end + p.optionAggregate * DAY;
  if (name === 'market_news') return (value as Collections['market_news']).receivedAt + p.news * DAY;
  return null; // Source minutes/snapshots require derived-data verification before arming TTL.
}
