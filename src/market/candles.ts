import type { Candle, Quote } from '../domain.js';
import { dayKey, MINUTE } from './time.js';
export interface VolumeDelta {
  volume: number | null;
  flags: string[];
}
export function candleId(key: string, interval: number, start: number): string {
  return `${key}:${interval}:${start}`;
}
export class CumulativeVolumeTracker {
  private state = new Map<string, { day: string; ts: number; volume: number }>();
  reset(key?: string) {
    if (key) this.state.delete(key);
    else this.state.clear();
  }
  observe(key: string, ts: number, cumulative: number | null, isIndex = false): VolumeDelta {
    if (isIndex) return { volume: null, flags: ['INDEX_SPOT_HAS_NO_TRADED_VOLUME'] };
    if (cumulative === null || !Number.isFinite(cumulative) || cumulative < 0)
      return { volume: null, flags: ['INVALID_VOLUME'] };
    const day = dayKey(ts),
      old = this.state.get(key);
    if (old && ts <= old.ts) return { volume: null, flags: ['DUPLICATE_OR_OUT_OF_ORDER'] };
    this.state.set(key, { day, ts, volume: cumulative });
    if (!old || old.day !== day)
      return { volume: null, flags: [old ? 'SESSION_RESET' : 'MISSING_INITIAL_BASELINE'] };
    if (cumulative < old.volume) return { volume: null, flags: ['VOLUME_CORRECTION'] };
    if (ts - old.ts > MINUTE) return { volume: null, flags: ['VOLUME_OBSERVATION_GAP'] };
    return { volume: cumulative - old.volume, flags: [] };
  }
}
export class CandleBuilder {
  private current = new Map<string, Candle>();
  private last = new Map<string, number>();
  readonly volumes = new CumulativeVolumeTracker();
  reset() {
    this.current.clear();
    this.last.clear();
    this.volumes.reset();
  }
  push(q: Quote, sessionOpen: number, sessionClose: number, isIndex = false): Candle[] {
    if (
      q.sourceTs < sessionOpen ||
      q.sourceTs >= sessionClose ||
      !Number.isFinite(q.ltp) ||
      q.ltp <= 0 ||
      q.sourceTs <= (this.last.get(q.instrumentKey) ?? 0)
    )
      return [];
    const previousTs = this.last.get(q.instrumentKey);
    this.last.set(q.instrumentKey, q.sourceTs);
    const delta = this.volumes.observe(q.instrumentKey, q.sourceTs, q.cumulativeVolume, isIndex);
    const start = sessionOpen + Math.floor((q.sourceTs - sessionOpen) / MINUTE) * MINUTE,
      old = this.current.get(q.instrumentKey),
      closed: Candle[] = [];
    if (previousTs !== undefined && previousTs < start && delta.volume !== null) {
      delta.volume = null;
      delta.flags.push('CROSS_MINUTE_VOLUME_ALLOCATION_UNCERTAIN');
    }
    if (old && old.start !== start) {
      old.complete = true;
      old.receivedAt = Math.max(q.receivedAt, old.end);
      closed.push(structuredClone(old));
      this.current.delete(q.instrumentKey);
    }
    let candle = this.current.get(q.instrumentKey);
    if (!candle) {
      candle = {
        id: candleId(q.instrumentKey, 1, start),
        instrumentKey: q.instrumentKey,
        interval: 1,
        start,
        end: start + MINUTE,
        open: q.ltp,
        high: q.ltp,
        low: q.ltp,
        close: q.ltp,
        volume: delta.volume,
        oi: q.oi,
        complete: false,
        quality: ['SAMPLED_TICK_OHLC', ...delta.flags],
        source: 'upstox-v3-ticks',
        receivedAt: q.receivedAt,
        mode: q.mode,
      };
      if (q.sourceTs - start > 2000) candle.quality.push('PARTIAL_MINUTE_OPEN');
      this.current.set(q.instrumentKey, candle);
    } else {
      candle.high = Math.max(candle.high, q.ltp);
      candle.low = Math.min(candle.low, q.ltp);
      candle.close = q.ltp;
      candle.volume = candle.volume === null || delta.volume === null ? null : candle.volume + delta.volume;
      candle.quality = [...new Set([...candle.quality, ...delta.flags])];
      candle.receivedAt = q.receivedAt;
      candle.oi = q.oi;
    }
    return closed;
  }
  flush(now: number, graceMs: number): Candle[] {
    const out: Candle[] = [];
    for (const [key, c] of this.current)
      if (c.end + graceMs <= now) {
        out.push({ ...c, complete: true, receivedAt: Math.max(now, c.receivedAt) });
        this.current.delete(key);
      }
    return out;
  }
}
export function aggregateCandles(
  rows: Candle[],
  interval: number,
  start: number,
  now: number,
): Candle | null {
  const end = start + interval * MINUTE;
  if (now < end) return null;
  const selected = rows
    .filter((c) => c.interval === 1 && c.start >= start && c.end <= end && c.complete && c.receivedAt <= now)
    .sort((a, b) => a.start - b.start);
  if (
    selected.length !== interval ||
    selected.some((c, i) => c.start !== start + i * MINUTE || c.end !== c.start + MINUTE)
  )
    return null;
  const first = selected[0]!,
    last = selected.at(-1)!;
  if (
    selected.some(
      (c) => c.instrumentKey !== first.instrumentKey || (c.mode === 'demo') !== (first.mode === 'demo'),
    )
  )
    return null;
  return {
    ...first,
    id: candleId(first.instrumentKey, interval, start),
    interval,
    start,
    end,
    high: Math.max(...selected.map((c) => c.high)),
    low: Math.min(...selected.map((c) => c.low)),
    close: last.close,
    volume: selected.some((c) => c.volume === null) ? null : selected.reduce((s, c) => s + c.volume!, 0),
    oi: last.oi,
    complete: true,
    quality: [...new Set(selected.flatMap((c) => c.quality))],
    source: 'validated-minute-aggregation',
    receivedAt: Math.max(...selected.map((c) => c.receivedAt)),
  };
}
