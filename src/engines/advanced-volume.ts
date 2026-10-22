import type { Candle, VolumeProfile } from '../domain.js';
import type { AdvancedVolume } from '../advanced-domain.js';
import type { Config } from '../config.js';
import { dayKey, minuteOfDay, atIST } from '../market/time.js';
import { vwap } from './volume.js';
export function volumeMoments(values: number[]) {
  if (!values.length || values.some((v) => !Number.isFinite(v) || v < 0)) return { mean: null, stdDev: null };
  // Welford's population variance avoids subtracting large squared totals.
  let mean = 0,
    m2 = 0,
    n = 0;
  for (const x of values) {
    n++;
    const delta = x - mean;
    mean += delta / n;
    m2 += delta * (x - mean);
  }
  return { mean, stdDev: Math.sqrt(m2 / n) };
}
export function volumeAcceleration(volumes: number[]): number | null {
  if (volumes.length < 3 || volumes.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const [a, b, c] = volumes.slice(-3) as [number, number, number];
  return a > 0 && b > 0 ? c / b - b / a : null; // Difference of successive volume growth ratios.
}
export function onBalanceVolume(rows: Candle[]): number | null {
  if (!rows.length || rows.some((c) => c.volume === null || c.volume < 0)) return null;
  let obv = 0;
  for (let i = 1; i < rows.length; i++)
    obv += Math.sign(rows[i]!.close - rows[i - 1]!.close) * rows[i]!.volume!;
  return obv;
}
export function accumulationDistribution(rows: Candle[]): number | null {
  if (!rows.length || rows.some((c) => c.volume === null || c.volume < 0 || c.high < c.low)) return null;
  return rows.reduce(
    (sum, c) =>
      sum + (c.high === c.low ? 0 : ((2 * c.close - c.high - c.low) / (c.high - c.low)) * c.volume!),
    0,
  );
}
export function priceVolumeDivergence(rows: Candle[]): AdvancedVolume['divergence'] {
  if (rows.length < 6 || rows.some((c) => c.volume === null)) return 'UNAVAILABLE';
  const n = Math.floor(rows.length / 2),
    first = rows.slice(0, n),
    last = rows.slice(-n);
  const a = volumeMoments(first.map((c) => c.volume!)).mean!,
    b = volumeMoments(last.map((c) => c.volume!)).mean!;
  if (a <= 0) return 'UNAVAILABLE';
  const price = last.at(-1)!.close / first[0]!.open - 1;
  return b < a * 0.8 ? (price > 0.001 ? 'BEARISH' : price < -0.001 ? 'BULLISH' : 'NONE') : 'NONE';
}
export function advancedVolume(
  rows: Candle[],
  profiles: VolumeProfile[],
  asOf: number,
  c: Config,
  opening: Candle | null = null,
  sectorRvol: number[] = [],
): AdvancedVolume {
  const available = rows
    .filter((r) => r.interval === 1 && r.complete && r.end <= asOf && r.receivedAt <= asOf)
    .sort((a, b) => a.start - b.start);
  const last = available.at(-1),
    recent = available.slice(-c.VOLUME_LOOKBACK);
  const quality: string[] = [];
  if (!last || recent.some((r) => r.volume === null || r.quality.length))
    quality.push('TRADED_VOLUME_UNAVAILABLE_OR_UNRELIABLE');
  if (recent.some((r, i) => i > 0 && r.start !== recent[i - 1]!.end)) quality.push('NON_CONTIGUOUS_LOOKBACK');
  const valid = quality.length === 0;
  const vols = valid ? recent.map((r) => r.volume!) : [];
  const moments = volumeMoments(vols);
  const seen = new Set<string>();
  const baseline = last
    ? profiles
        .filter(
          (p) =>
            p.instrumentKey === last.instrumentKey &&
            p.interval === 1 &&
            p.minute === minuteOfDay(last.start) &&
            p.day < dayKey(last.start) &&
            p.receivedAt <= asOf &&
            p.valid &&
            p.volume >= 0 &&
            (p.mode === 'demo') === (last.mode === 'demo'),
        )
        .sort((a, b) => b.day.localeCompare(a.day))
        .filter((p) => {
          if (seen.has(p.day)) return false;
          seen.add(p.day);
          return true;
        })
        .slice(0, c.BASELINE_SESSIONS)
    : [];
  const same = volumeMoments(baseline.map((p) => p.volume));
  const z =
    valid &&
    last?.volume !== null &&
    last?.volume !== undefined &&
    baseline.length >= c.BASELINE_MIN_SAMPLES &&
    same.stdDev &&
    same.mean !== null
      ? (last.volume - same.mean) / same.stdDev
      : null;
  const session = last ? available.filter((r) => dayKey(r.start) === dayKey(last.start)) : [];
  const sessionContinuous =
    session.length > 0 &&
    session[0]!.start === (opening?.start ?? atIST(dayKey(last!.start), '09:15')) &&
    session.every((r, i) => r.quality.length === 0 && (i === 0 || r.start === session[i - 1]!.end));
  const sessionVwap = sessionContinuous ? vwap(session) : null;
  const acceleration = valid ? volumeAcceleration(vols) : null,
    divergence = valid ? priceVolumeDivergence(recent) : 'UNAVAILABLE';
  const rangeReady =
    opening &&
    opening.end <= asOf &&
    opening.receivedAt <= asOf &&
    opening.quality.length === 0 &&
    last &&
    last.end > opening.end;
  const breakout: AdvancedVolume['breakout'] = !rangeReady
    ? 'UNAVAILABLE'
    : last.close > opening.high
      ? 'UP'
      : last.close < opening.low
        ? 'DOWN'
        : 'NONE';
  const falseBreakout: AdvancedVolume['falseBreakout'] = !rangeReady
    ? 'UNAVAILABLE'
    : last.high > opening.high && last.close < opening.high
      ? 'UPPER_REJECTED'
      : last.low < opening.low && last.close > opening.low
        ? 'LOWER_REJECTED'
        : 'NONE';
  const rvol =
    last?.volume !== null &&
    last?.volume !== undefined &&
    same.mean &&
    baseline.length >= c.BASELINE_MIN_SAMPLES
      ? last.volume / same.mean
      : null;
  const change = last ? (last.close - last.open) / last.open : 0;
  let participation: AdvancedVolume['participation'] = 'INCONCLUSIVE';
  if (!valid) participation = 'UNAVAILABLE';
  else if (falseBreakout !== 'NONE' && falseBreakout !== 'UNAVAILABLE')
    participation = 'POSSIBLE_FALSE_BREAKOUT';
  else if (divergence === 'BULLISH' || divergence === 'BEARISH') participation = 'PRICE_VOLUME_DIVERGENCE';
  else if (
    acceleration !== null &&
    acceleration < -0.5 &&
    vols.length >= 3 &&
    vols.at(-2)! > vols.at(-3)! * c.VOLUME_SPIKE_RATIO
  )
    participation = 'VOLUME_EXHAUSTION';
  else if ((rvol !== null && rvol >= c.MIN_RVOL) || (z !== null && z >= c.VOLUME_ANOMALY_Z)) {
    participation =
      breakout === 'UP' || breakout === 'DOWN'
        ? 'POSSIBLE_BREAKOUT'
        : Math.abs(change) < 0.001
          ? 'ABNORMAL_NON_DIRECTIONAL'
          : change > 0
            ? 'STRONG_UPWARD'
            : 'STRONG_DOWNWARD';
  } else if (rvol !== null && rvol < 1) participation = 'WEAK';
  const peer = volumeMoments(sectorRvol).mean;
  return {
    asOf,
    version: 'advanced-volume:1.0.0',
    instrumentKey: last?.instrumentKey ?? '',
    sampleCount: recent.length,
    lookback: c.VOLUME_LOOKBACK,
    volumeMean: moments.mean,
    volumeStdDev: moments.stdDev,
    volumeZScore: z,
    volumeAcceleration: acceleration,
    obv: valid ? onBalanceVolume(recent) : null,
    accumulationDistribution: valid ? accumulationDistribution(recent) : null,
    vwap: sessionVwap,
    vwapDeviationPct: sessionVwap && last ? (last.close / sessionVwap - 1) * 100 : null,
    divergence,
    breakout,
    falseBreakout,
    participation,
    sectorRelativeParticipation: rvol !== null && peer && sectorRvol.length >= 3 ? rvol / peer : null,
    quality: [
      ...quality,
      ...(z === null ? ['SAME_TIME_Z_SCORE_UNAVAILABLE'] : []),
      ...(!sessionContinuous ? ['SESSION_VWAP_INCOMPLETE'] : []),
      ...(sectorRvol.length < 3 ? ['SECTOR_PEER_DATA_UNAVAILABLE'] : []),
    ],
    methodology:
      'v1: population volume SD; z-score against same-minute prior sessions; acceleration = Vt/Vt-1 minus Vt-1/Vt-2; OBV and ADL rebased to rolling window; candle typical-price VWAP approximation, not exchange trade VWAP; all participation labels are hypotheses',
  };
}
/** Keeps bounded completed-minute history in memory; repeats/corrections replace the same start. */
export class IncrementalVolumeState {
  private series = new Map<string, Candle[]>();
  private totals = new Map<
    string,
    { count: number; invalid: number; volume: number; weightedPrice: number }
  >();
  private adjust(c: Candle, sign: 1 | -1) {
    const key = `${c.instrumentKey}:${dayKey(c.start)}`;
    const sum = this.totals.get(key) ?? { count: 0, invalid: 0, volume: 0, weightedPrice: 0 };
    sum.count += sign;
    if (c.volume === null || c.volume < 0 || c.quality.length) sum.invalid += sign;
    else {
      sum.volume += sign * c.volume;
      sum.weightedPrice += (sign * c.volume * (c.high + c.low + c.close)) / 3;
    }
    if (sum.count) this.totals.set(key, sum);
    else this.totals.delete(key);
  }
  observe(c: Candle) {
    if (c.interval !== 1 || !c.complete) return;
    const rows = this.series.get(c.instrumentKey) ?? [];
    const i = rows.findIndex((r) => r.start === c.start);
    if (i >= 0) {
      this.adjust(rows[i]!, -1);
      rows[i] = c;
    } else rows.push(c);
    this.adjust(c, 1);
    rows.sort((a, b) => a.start - b.start);
    if (rows.length > 500) for (const removed of rows.slice(0, -500)) this.adjust(removed, -1);
    this.series.set(c.instrumentKey, rows.slice(-500));
  }
  rows(key: string) {
    return this.series.get(key) ?? [];
  }
  sessionVwap(key: string, day: string, open = atIST(day, '09:15')) {
    const sum = this.totals.get(`${key}:${day}`);
    const rows = this.rows(key).filter((c) => dayKey(c.start) === day);
    return sum &&
      !sum.invalid &&
      sum.volume > 0 &&
      rows[0]?.start === open &&
      rows.every((c, i) => i === 0 || c.start === rows[i - 1]!.end)
      ? sum.weightedPrice / sum.volume
      : null;
  }
  reset() {
    this.series.clear();
    this.totals.clear();
  }
}
