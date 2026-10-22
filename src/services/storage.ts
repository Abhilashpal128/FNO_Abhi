import type { Store } from '../db/store.js';
import type { Config } from '../config.js';
import type { StorageReport, DatabaseStorage } from '../advanced-domain.js';
import type { MarketService } from './market.js';
import { atIST, dayKey, MINUTE } from '../market/time.js';
import { aggregateCandles, candleId } from '../market/candles.js';
import { compactOptions } from '../market/sampling.js';
export function assessStorage(
  stats: DatabaseStorage,
  previous: StorageReport | null,
  now: number,
  c: Config,
  retention: StorageReport['retention'],
): StorageReport {
  const budgetBytes = c.STORAGE_BUDGET_MB * 1024 * 1024,
    usedPct = stats.measured ? (stats.totalBytes / budgetBytes) * 100 : null;
  const elapsed = previous ? now - previous.checkedAt : 0;
  const dailyGrowthBytes =
    stats.measured && previous?.measured && elapsed >= 3600000
      ? ((stats.totalBytes - previous.totalBytes) * 86400000) / elapsed
      : null;
  const level =
    usedPct === null
      ? 'UNAVAILABLE'
      : usedPct >= c.STORAGE_CRITICAL_PCT
        ? 'CRITICAL'
        : usedPct >= c.STORAGE_REDUCE_PCT
          ? 'REDUCED'
          : usedPct >= c.STORAGE_WARN_PCT
            ? 'WARNING'
            : 'NORMAL';
  return {
    id: dayKey(now),
    checkedAt: now,
    ...stats,
    budgetBytes,
    usedPct,
    dailyGrowthBytes,
    daysToThreshold:
      dailyGrowthBytes !== null && dailyGrowthBytes > 0
        ? Math.max(0, (budgetBytes * c.STORAGE_CRITICAL_PCT) / 100 - stats.totalBytes) / dailyGrowthBytes
        : null,
    level,
    optionalSnapshotStride: level === 'CRITICAL' || level === 'UNAVAILABLE' ? 0 : level === 'REDUCED' ? 5 : 1,
    retention,
  };
}
export class StorageHealthService {
  latest: StorageReport | null = null;
  private busy = false;
  constructor(
    private store: Store,
    private market: MarketService,
    private config: Config,
  ) {}
  async check(now: number) {
    if (this.busy) return this.latest;
    this.busy = true;
    let retention: StorageReport['retention'];
    try {
      try {
        retention = await this.prepareRetention(now);
      } catch {
        retention = { status: 'FAILED', checkedAt: now, armed: 0, pending: 0 };
      }
      const previous =
        (
          await this.store.find(
            'storage_health',
            { checkedAt: { $lte: now - 3600000 } },
            { sort: { checkedAt: -1 }, limit: 1 },
          )
        )[0] ?? null;
      let stats: DatabaseStorage;
      try {
        stats = await this.store.storageStats();
      } catch {
        stats = {
          measured: false,
          collections: [],
          dataBytes: 0,
          storageBytes: 0,
          indexBytes: 0,
          totalBytes: 0,
        };
      }
      this.latest = assessStorage(stats, previous, now, this.config, retention);
      // Demo has no physical database budget; storage measurement failure in live mode stops optional data.
      this.market.snapshotStride = this.config.DATA_MODE === 'demo' ? 1 : this.latest.optionalSnapshotStride;
      await this.store.put('storage_health', this.latest);
      await this.store.put('system_health', {
        id: 'storage',
        status: this.latest.level === 'NORMAL' ? 'OK' : 'DEGRADED',
        checkedAt: now,
        details: [`Storage ${this.latest.level}`, `Retention ${retention.status}`],
      });
      return this.latest;
    } finally {
      this.busy = false;
    }
  }
  async prepareRetention(now: number): Promise<StorageReport['retention']> {
    let armed = 0,
      pending = 0;
    const today = atIST(dayKey(now), '00:00');
    // Recover closed buckets after restarts, subscription changes or a missed flush.
    const observations = await this.store.find('option_snapshots', {
      sourceTs: { $lt: Math.floor(now / (5 * MINUTE)) * 5 * MINUTE },
      retentionAt: { $exists: false },
    }, { sort: { sourceTs: 1 }, limit: 2500 });
    const buckets = new Map<string, { key: string; start: number }>();
    for (const q of observations) {
      const start = Math.floor(q.sourceTs / (5 * MINUTE)) * 5 * MINUTE;
      buckets.set(`${q.instrumentKey}:${start}`, { key: q.instrumentKey, start });
    }
    for (const { key, start } of [...buckets.values()].slice(0, 100)) {
      const rows = await this.store.find('option_snapshots', {
        instrumentKey: key, sourceTs: { $gte: start, $lt: start + 5 * MINUTE },
      }, { sort: { sourceTs: 1 }, limit: 10000 });
      const compact = compactOptions(rows, start, now);
      if (!compact) { pending += rows.length; continue; }
      await this.store.put('option_aggregates', compact);
      if (!(await this.store.get('option_aggregates', compact.id))) throw new Error('Missing compact observation');
      await this.store.armRetention('option_snapshots', rows.map((r) => r.id),
        compact.end + this.config.SNAPSHOT_RETENTION_DAYS * 86400000);
      armed += rows.length;
    }
    // Bound each maintenance pass. Missing derived data leaves the source without a TTL date.
    const candidates = await this.store.find(
      'market_candles',
      { interval: 1, complete: true, end: { $lte: today }, retentionAt: { $exists: false },
        $or: [{ retentionRetryAt: { $exists: false } }, { retentionRetryAt: { $lte: new Date(now) } }],
      },
      { sort: { start: 1 }, limit: 400 },
    );
    const groups = [...new Set(candidates.map((c) => `${c.instrumentKey}~${dayKey(c.start)}`))].slice(0, 10);
    for (const group of groups) {
      const [key, day] = group.split('~') as [string, string];
      const session = await this.store.get('market_sessions', day);
      const open = session?.open ?? atIST(day, '09:15'),
        close = session?.close ?? atIST(day, '15:30');
      const rows = await this.store.find(
        'market_candles',
        { instrumentKey: key, interval: 1, start: { $gte: open, $lt: close } },
        { sort: { start: 1 }, limit: 1500 },
      );
      await this.market.persistHistory(rows, now);
      const aggregates = await this.store.find('market_candles', {
        instrumentKey: key, start: { $gte: open, $lt: close }, interval: { $in: [5, 15, 30] },
      }, { limit: 1500 });
      const byWindow = new Map(aggregates.map((c) => [`${c.interval}:${c.start}`, c]));
      const ids: string[] = [];
      let safe = true;
      for (const c of rows) {
        for (const interval of [5, 15, 30]) {
          const start = open + Math.floor((c.start - open) / (interval * MINUTE)) * interval * MINUTE;
          if (start + interval * MINUTE > close) continue;
          const derived = byWindow.get(`${interval}:${start}`);
          if (!derived?.complete || derived.receivedAt > now) {
            safe = false;
            break;
          }
          ids.push(derived.id);
        }
        if (!safe) break;
      }
      const daily = aggregateCandles(rows, Math.round((close - open) / MINUTE), open, now);
      const existingDaily = (await this.store.find('market_candles', {
        instrumentKey: key, interval: 1440, start: { $gte: atIST(day, '00:00'), $lt: close },
      }, { limit: 1 }))[0];
      if (daily && (!existingDaily || existingDaily.source === 'complete-session-minute-aggregation')) {
        await this.store.put('market_candles', {
          ...daily,
          id: candleId(key, 1440, open),
          interval: 1440,
          end: close,
          source: 'complete-session-minute-aggregation',
        });
      }
      if (!daily) safe = false;
      if (safe && rows.length) {
        const profiles = await this.store.find(
          'market_volume_profiles',
          { instrumentKey: key, day },
          { limit: 3000 },
        );
        if (
          rows.some(
            (r) =>
              r.volume !== null &&
              r.quality.length === 0 &&
              !profiles.some(
                (p) =>
                  p.interval === 1 &&
                  p.minute === Math.round((r.start - atIST(day, '00:00')) / MINUTE) &&
                  p.volume === r.volume,
              ),
          )
        )
          safe = false;
      }
      await this.store.put('retention_checkpoints', {
        id: group,
        instrumentKey: key,
        day,
        checkedAt: now,
        status: safe ? 'READY' : 'INCOMPLETE',
        sourceCount: rows.length,
        aggregateIds: [...new Set(ids)],
      });
      if (safe) {
        await this.store.armRetention(
          'market_candles',
          rows.map((c) => c.id),
          close + this.config.CANDLE_MINUTE_RETENTION_DAYS * 86400000,
        );
        armed += rows.length;
      } else {
        const deferredIds = [...new Set([...rows, ...candidates.filter((c) => `${c.instrumentKey}~${dayKey(c.start)}` === group)].map((r) => r.id))];
        pending += deferredIds.length;
        // Retry incomplete sessions tomorrow, allowing later sessions to be processed now.
        await this.store.deferRetention('market_candles', deferredIds, now + 86400000);
      }
    }
    return { status: pending ? 'DEGRADED' : 'OK', checkedAt: now, armed, pending };
  }
}
