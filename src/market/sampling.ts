import type { Quote } from '../domain.js';
import type { OptionAggregate } from '../advanced-domain.js';
import { MINUTE, dayKey } from './time.js';
/** One terminal observed quote per completed minute, with a deterministic ID across reconnects. */
export class MinuteSampler {
  private pending = new Map<string, Quote>();
  observe(q: Quote) {
    const bucket = Math.floor(q.sourceTs / MINUTE) * MINUTE,
      key = `minute:${q.instrumentKey}:${bucket}`;
    const old = this.pending.get(key);
    if (!old || old.sourceTs < q.sourceTs) this.pending.set(key, { ...q, id: key });
  }
  completed(now: number): Quote[] {
    return [...this.pending.values()]
      .filter((q) => Math.floor(q.sourceTs / MINUTE) * MINUTE + MINUTE <= now)
      .sort((a, b) => a.sourceTs - b.sourceTs);
  }
  acknowledge(rows: Quote[]) {
    for (const q of rows) this.pending.delete(q.id);
  }
  get size() {
    return this.pending.size;
  }
  clear() { this.pending.clear(); }
  trim(max: number) {
    while (this.pending.size > max) this.pending.delete(this.pending.keys().next().value!);
  }
}
export function compactOptions(quotes: Quote[], start: number, now: number): OptionAggregate | null {
  const end = start + 5 * MINUTE;
  if (end > now) return null;
  const rows = quotes
    .filter((q) => q.sourceTs >= start && q.sourceTs < end && q.receivedAt <= now)
    .sort((a, b) => a.sourceTs - b.sourceTs);
  const first = rows[0],
    last = rows.at(-1);
  if (!first || !last || rows.some((q) => q.instrumentKey !== first.instrumentKey)) return null;
  const spreads = rows.flatMap((q) =>
    q.ask && q.bid && q.ask >= q.bid ? [((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100] : [],
  );
  const volume =
    first.cumulativeVolume !== null &&
    last.cumulativeVolume !== null &&
    last.cumulativeVolume >= first.cumulativeVolume &&
    dayKey(first.sourceTs) === dayKey(last.sourceTs)
      ? last.cumulativeVolume - first.cumulativeVolume
      : null;
  return {
    id: `compact:${first.instrumentKey}:${start}`,
    instrumentKey: first.instrumentKey,
    start,
    end,
    receivedAt: now,
    mode: first.mode,
    samples: rows.length,
    firstSourceTs: first.sourceTs,
    lastSourceTs: last.sourceTs,
    open: first.ltp,
    high: Math.max(...rows.map((q) => q.ltp)),
    low: Math.min(...rows.map((q) => q.ltp)),
    close: last.ltp,
    bid: last.bid,
    ask: last.ask,
    cumulativeVolume: last.cumulativeVolume,
    observedVolumeChange: volume,
    oi: last.oi,
    oiChange: first.oi !== null && last.oi !== null ? last.oi - first.oi : null,
    oiAsOf: last.oiAsOf,
    maxSpreadPct: spreads.length ? Math.max(...spreads) : null,
    quality: [
      'SAMPLED_QUOTES_NOT_EXCHANGE_OHLC',
      'OBSERVED_VOLUME_CHANGE_NOT_FULL_INTERVAL_VOLUME',
      ...(rows.length < 5 ? ['INCOMPLETE_MINUTE_COVERAGE'] : []),
    ],
    source: 'selected-minute-quote-aggregation-v1',
  };
}
