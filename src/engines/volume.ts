import type { Candle, VolumeFeatures, VolumeProfile, Quote } from '../domain.js';
import type { Config } from '../config.js';
import { dayKey, minuteOfDay } from '../market/time.js';
export function mean(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
/** Typical-price candle VWAP approximation, never represented as exchange tick VWAP. */
export function vwap(candles: Candle[]): number | null {
  if (!candles.length || candles.some((c) => c.volume === null || c.volume < 0)) return null;
  const volume = candles.reduce((s, c) => s + c.volume!, 0);
  return volume > 0
    ? candles.reduce((s, c) => s + ((c.high + c.low + c.close) / 3) * c.volume!, 0) / volume
    : null;
}
export function historicalBaseline(
  candle: Candle,
  profiles: VolumeProfile[],
  asOf: number,
  lookback: number,
  minSamples: number,
): { average: number | null; samples: number } {
  const seen = new Set<string>();
  const valid = profiles
    .filter(
      (p) =>
        p.instrumentKey === candle.instrumentKey &&
        p.interval === candle.interval &&
        p.minute === minuteOfDay(candle.start) &&
        p.day < dayKey(candle.start) &&
        p.receivedAt <= asOf &&
        p.valid &&
        Number.isFinite(p.volume) &&
        p.volume >= 0 &&
        (candle.mode === 'demo' ? p.mode === 'demo' : p.mode !== 'demo'),
    )
    .sort((a, b) => b.day.localeCompare(a.day))
    .filter((p) => {
      if (seen.has(p.day)) return false;
      seen.add(p.day);
      return true;
    })
    .slice(0, lookback);
  const avg = mean(valid.map((p) => p.volume));
  return {
    average: valid.length >= minSamples && avg !== null && avg > 0 ? avg : null,
    samples: valid.length,
  };
}
export function priceVolumeRelationship(priceChange: number, volumeRatio: number | null): string {
  if (volumeRatio === null) return 'UNKNOWN';
  const volume = volumeRatio > 1.05 ? 'EXPANDING' : volumeRatio < 0.95 ? 'DECLINING' : 'STABLE';
  if (Math.abs(priceChange) < 0.001)
    return volume === 'EXPANDING' ? 'HIGH_VOLUME_WITHOUT_PRICE_PROGRESS' : 'FLAT_PRICE';
  return `${priceChange > 0 ? 'RISING' : 'FALLING'}_PRICE_${volume}_VOLUME`;
}
export function volumeIntelligence(
  current: Candle | null,
  opening: Candle | null,
  sessionCandles: Candle[],
  profiles: VolumeProfile[],
  asOf: number,
  config: Config,
): VolumeFeatures {
  const baseline = current
    ? historicalBaseline(current, profiles, asOf, config.BASELINE_SESSIONS, config.BASELINE_MIN_SAMPLES)
    : { average: null, samples: 0 };
  const openingBaseline = opening
    ? historicalBaseline(opening, profiles, asOf, config.BASELINE_SESSIONS, config.BASELINE_MIN_SAMPLES)
    : { average: null, samples: 0 };
  const valid = (c: Candle | null) =>
    c !== null &&
    c.complete &&
    c.end <= asOf &&
    c.receivedAt <= asOf &&
    c.volume !== null &&
    c.quality.length === 0;
  const volume = valid(current) ? current!.volume : null,
    openingVolume = valid(opening) ? opening!.volume : null;
  const ratio = volume !== null && baseline.average ? volume / baseline.average : null;
  const flags = [
    ...new Set([
      ...(current?.quality ?? ['MISSING_INTERVAL']),
      ...(baseline.average === null ? ['INSUFFICIENT_SAME_TIME_BASELINE'] : []),
    ]),
  ];
  const change = current ? (current.close - current.open) / current.open : 0;
  const vwapRows = sessionCandles
    .filter((c) => c.complete && c.end <= asOf && c.receivedAt <= asOf)
    .sort((a, b) => a.start - b.start);
  const sessionComplete =
    opening &&
    vwapRows[0]?.start === opening.start &&
    vwapRows.every((c, i) => c.quality.length === 0 && (i === 0 || c.start === vwapRows[i - 1]!.end));
  return {
    asOf,
    methodology:
      'volume-v1: completed interval / mean of valid earlier sessions at identical IST minute and duration; candle typical-price VWAP',
    volumeInstrumentKey: current?.instrumentKey ?? opening?.instrumentKey ?? '',
    openingFiveMinuteVolume: openingVolume,
    openingFiveMinuteRvol:
      openingVolume !== null && openingBaseline.average ? openingVolume / openingBaseline.average : null,
    intervalVolume: volume,
    sameTimeHistoricalAverageVolume: baseline.average,
    volumeSpikeRatio: ratio,
    baselineSamples: baseline.samples,
    volumeTrend:
      ratio === null ? 'UNKNOWN' : ratio > 1.05 ? 'EXPANDING' : ratio < 0.95 ? 'DECLINING' : 'FLAT',
    priceVolumeRelationship: priceVolumeRelationship(change, ratio),
    vwap: sessionComplete ? vwap(vwapRows) : null,
    volumeConfirmationStatus:
      ratio === null
        ? 'INSUFFICIENT_DATA'
        : ratio >= config.MIN_RVOL && Math.abs(change) >= 0.001
          ? 'CONFIRMED'
          : 'UNCONFIRMED',
    dataQualityFlags: flags,
  };
}
export class VolumeCandidateFilter {
  constructor(private config: Config) {}
  evaluate(features: VolumeFeatures, directionConfirmed: boolean): string[] {
    const reasons: string[] = [];
    if (features.dataQualityFlags.length) reasons.push(...features.dataQualityFlags);
    if (features.volumeConfirmationStatus !== 'CONFIRMED') reasons.push('VOLUME_NOT_CONFIRMED');
    if (!directionConfirmed) reasons.push('DIRECTION_NOT_CONFIRMED');
    return [...new Set(reasons)];
  }
  isSpike(features: VolumeFeatures): boolean {
    return (features.volumeSpikeRatio ?? 0) >= this.config.VOLUME_SPIKE_RATIO;
  }
}
export function derivativesVolume(q: Quote, now: number) {
  return {
    asOf: now,
    methodology:
      'provider native units; OI delta against provider previous-session OI; no participant intent inferred',
    optionContractVolume: q.cumulativeVolume,
    optionVolumeToOI: q.oi && q.cumulativeVolume !== null ? q.cumulativeVolume / q.oi : null,
    oiChange: q.oi !== null && q.previousOi !== null ? q.oi - q.previousOi : null,
    oiAsOf: q.oiAsOf,
    oiFreshnessKnown: q.oiAsOf !== null,
    iv: q.iv,
    qualityFlags: q.oiAsOf === null ? ['OI_UPDATE_TIMESTAMP_UNAVAILABLE'] : [],
  };
}
export function putCallRatio(
  calls: Quote[],
  puts: Quote[],
): { oiPcr: number | null; volumePcr: number | null; methodology: string } {
  const ratio = (field: 'oi' | 'cumulativeVolume') => {
    if (!calls.length || !puts.length || [...calls, ...puts].some((q) => q[field] === null)) return null;
    const ce = calls.reduce((s, q) => s + q[field]!, 0),
      pe = puts.reduce((s, q) => s + q[field]!, 0);
    return ce > 0 ? pe / ce : null;
  };
  return {
    oiPcr: ratio('oi'),
    volumePcr: ratio('cumulativeVolume'),
    methodology: 'sum PE / sum CE; identical expiry and selected strike universe must be supplied',
  };
}
