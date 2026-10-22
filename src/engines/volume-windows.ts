import type { Candle, MarketSession, Quote, VolumeProfile } from '../domain.js';
import type { Config } from '../config.js';
import { aggregateCandles } from '../market/candles.js';
import { MINUTE } from '../market/time.js';
import { historicalBaseline, mean, priceVolumeRelationship, vwap } from './volume.js';
export function volumeWindows(
  rows: Candle[],
  profiles: VolumeProfile[],
  session: MarketSession | null,
  quote: Quote | null,
  asOf: number,
  c: Config,
) {
  const valid = rows.filter(
      (r) => r.complete && r.end <= asOf && r.receivedAt <= asOf && r.quality.length === 0,
    ),
    minuteRows = valid.filter((r) => r.interval === 1);
  const windows = [1, 5, 15, 30].map((interval) => {
    if (!session) return { interval, volume: null, rvol: null, baselineSamples: 0, start: null, end: null };
    const end =
        session.open +
        Math.floor((Math.min(asOf, session.close) - session.open) / (interval * MINUTE)) * interval * MINUTE,
      start = end - interval * MINUTE;
    const bar = start >= session.open ? aggregateCandles(minuteRows, interval, start, asOf) : null;
    const baseline = bar
      ? historicalBaseline(bar, profiles, asOf, c.BASELINE_SESSIONS, c.BASELINE_MIN_SAMPLES)
      : { average: null, samples: 0 };
    return {
      interval,
      start: start >= session.open ? start : null,
      end: end > session.open ? end : null,
      volume: bar?.volume ?? null,
      rvol:
        bar?.volume !== null && bar?.volume !== undefined && baseline.average
          ? bar.volume / baseline.average
          : null,
      baselineSamples: baseline.samples,
    };
  });
  const daily = valid.filter((b) => b.interval === 1440).sort((a, b) => a.start - b.start),
    lastDaily = daily.at(-1),
    priorDaily = daily
      .slice(0, -1)
      .slice(-c.BASELINE_SESSIONS)
      .filter((b) => b.volume !== null),
    dailyAverage = mean(priorDaily.map((b) => b.volume!));
  const sessionRows = session
      ? minuteRows.filter((b) => b.start >= session.open && b.end <= session.close)
      : [],
    recent = sessionRows.slice(-10),
    older = recent.slice(0, 5),
    newer = recent.slice(5),
    oldVol = older.reduce((sum, b) => sum + (b.volume ?? 0), 0),
    newVol = newer.reduce((sum, b) => sum + (b.volume ?? 0), 0);
  const comparison =
    recent.length === 10 &&
    recent.every((b, i) => b.volume !== null && (i === 0 || b.start === recent[i - 1]!.end)) &&
    oldVol > 0
      ? newVol / oldVol
      : null;
  const priceChange = recent.length === 10 ? recent.at(-1)!.close / recent[0]!.open - 1 : 0;
  const anomalies = sessionRows.filter((b) => {
    const baseline = historicalBaseline(b, profiles, asOf, c.BASELINE_SESSIONS, c.BASELINE_MIN_SAMPLES);
    return (
      b.volume !== null && baseline.average !== null && b.volume / baseline.average >= c.VOLUME_SPIKE_RATIO
    );
  });
  return {
    asOf,
    methodology:
      'volume-windows-v1: completed windows anchored to session open; same-minute prior-session baselines; daily RVOL only for last completed daily candle',
    sessionCumulativeVolume: quote?.cumulativeVolume ?? null,
    windows,
    daily: {
      dayStart: lastDaily?.start ?? null,
      volume: lastDaily?.volume ?? null,
      rvol:
        lastDaily?.volume !== null &&
        lastDaily?.volume !== undefined &&
        dailyAverage &&
        priorDaily.length >= c.BASELINE_MIN_SAMPLES
          ? lastDaily.volume / dailyAverage
          : null,
      samples: priorDaily.length,
    },
    sessionVwap:
      sessionRows.length &&
      sessionRows[0]!.start === session?.open &&
      sessionRows.every((b, i) => i === 0 || b.start === sessionRows[i - 1]!.end)
        ? vwap(sessionRows)
        : null,
    recentPriceVolumeRelationship: priceVolumeRelationship(priceChange, comparison),
    divergenceHypothesis: comparison !== null && comparison < 0.8 && Math.abs(priceChange) > 0.001,
    unusualVolumeMinutes: anomalies.map((b) => b.start),
    repeatedAnomaly: anomalies.length >= 3,
    limitations: [
      'Divergence and exhaustion are hypotheses requiring validation',
      'Missing windows and baselines return null',
      'Index spot has no traded volume; use the explicitly identified futures proxy',
    ],
  };
}
export function priceOiRelationship(priceChange: number, oiChange: number | null): string {
  if (oiChange === null) return 'OI_CHANGE_UNAVAILABLE';
  if (priceChange === 0 || oiChange === 0) return 'NO_JOINT_CHANGE';
  return `${priceChange > 0 ? 'PRICE_UP' : 'PRICE_DOWN'}_${oiChange > 0 ? 'OI_UP' : 'OI_DOWN'}_OBSERVATION_ONLY`;
}
