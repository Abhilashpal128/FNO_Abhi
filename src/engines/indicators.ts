import type { Candle, TechnicalFeatures, Regime } from '../domain.js';
import { mean } from './volume.js';
export function sma(values: number[], period: number): number | null {
  return period > 0 && values.length >= period ? mean(values.slice(-period)) : null;
}
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  if (period < 1 || values.length < period) return out;
  let current = mean(values.slice(0, period))!;
  out[period - 1] = current;
  for (let i = period; i < values.length; i++) {
    current = values[i]! * (2 / (period + 1)) + current * (1 - 2 / (period + 1));
    out[i] = current;
  }
  return out;
}
export function ema(values: number[], period: number): number | null {
  return emaSeries(values, period).at(-1) ?? null;
}
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0,
    loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    gain += Math.max(d, 0) / period;
    loss += Math.max(-d, 0) / period;
  }
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  return loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
}
export function macd(values: number[], fast = 12, slow = 26, signal = 9): TechnicalFeatures['macd'] {
  const a = emaSeries(values, fast),
    b = emaSeries(values, slow),
    diff = values
      .map((_, i) => (a[i] !== null && b[i] !== null ? a[i]! - b[i]! : null))
      .filter((v): v is number => v !== null);
  const sig = ema(diff, signal),
    last = diff.at(-1);
  return sig === null || last === undefined ? null : { macd: last, signal: sig, histogram: last - sig };
}
export function trueRanges(c: Candle[]): number[] {
  return c.map((x, i) =>
    i === 0
      ? x.high - x.low
      : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1]!.close), Math.abs(x.low - c[i - 1]!.close)),
  );
}
function wilder(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const out = [mean(values.slice(0, period))!];
  for (let i = period; i < values.length; i++) out.push((out.at(-1)! * (period - 1) + values[i]!) / period);
  return out;
}
export function atr(c: Candle[], period = 14): number | null {
  return wilder(trueRanges(c), period).at(-1) ?? null;
}
export function adx(c: Candle[], period = 14): number | null {
  if (c.length < period * 2) return null;
  const plus: number[] = [],
    minus: number[] = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i]!.high - c[i - 1]!.high,
      down = c[i - 1]!.low - c[i]!.low;
    plus.push(up > down && up > 0 ? up : 0);
    minus.push(down > up && down > 0 ? down : 0);
  }
  const tr = wilder(trueRanges(c).slice(1), period),
    p = wilder(plus, period),
    m = wilder(minus, period);
  const dx = tr.map((v, i) => {
    if (v === 0) return 0;
    const pi = (100 * p[i]!) / v,
      mi = (100 * m[i]!) / v;
    return pi + mi === 0 ? 0 : (100 * Math.abs(pi - mi)) / (pi + mi);
  });
  return wilder(dx, period).at(-1) ?? null;
}
export function bollinger(values: number[], period = 20, multiplier = 2): TechnicalFeatures['bollinger'] {
  const middle = sma(values, period);
  if (middle === null) return null;
  const deviation = Math.sqrt(values.slice(-period).reduce((s, v) => s + (v - middle) ** 2, 0) / period);
  return { lower: middle - multiplier * deviation, middle, upper: middle + multiplier * deviation };
}
export function technicalFeatures(candles: Candle[], asOf: number): TechnicalFeatures {
  const c = candles
      .filter((c) => c.complete && c.end <= asOf && c.receivedAt <= asOf && c.quality.length === 0)
      .sort((a, b) => a.start - b.start),
    closes = c.map((c) => c.close),
    window = c.slice(-20);
  return {
    sma: sma(closes, 20),
    ema: ema(closes, 9),
    rsi: rsi(closes),
    macd: macd(closes),
    atr: atr(c),
    adx: adx(c),
    bollinger: bollinger(closes),
    support: window.length ? Math.min(...window.map((c) => c.low)) : null,
    resistance: window.length ? Math.max(...window.map((c) => c.high)) : null,
    momentum: closes.length >= 6 ? closes.at(-1)! / closes.at(-6)! - 1 : null,
  };
}
export function marketRegime(
  t: TechnicalFeatures,
  price: number,
  highImpactNews: boolean,
  maxAtrPct = 3,
): Regime {
  if (t.atr === null || t.adx === null || t.ema === null) return 'INSUFFICIENT_DATA';
  if (highImpactNews) return 'NEWS_DRIVEN';
  if ((t.atr / price) * 100 > maxAtrPct) return 'HIGH_VOLATILITY';
  if (t.adx < 20) return 'SIDEWAYS';
  return price >= t.ema ? 'BULLISH_TRENDING' : 'BEARISH_TRENDING';
}
