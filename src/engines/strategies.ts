import type { Strategy, StrategyContext } from './strategy.js';
import type { Direction, Regime, StrategyDecision } from '../domain.js';
const trends: Regime[] = ['BULLISH_TRENDING', 'BEARISH_TRENDING'];
const broad: Regime[] = [...trends, 'SIDEWAYS'];
type Assessment = { direction?: Direction; reason: string };
function make(id: string, regimes: Regime[], rule: (c: StrategyContext) => Assessment): Strategy {
  return {
    id,
    version: '1.0.0',
    regimes,
    evaluate(c) {
      const out: StrategyDecision = {
        strategyId: id,
        version: this.version,
        direction: null,
        underlyingEntry: null,
        invalidation: null,
        target1: null,
        target2: null,
        reasons: [],
        conflicts: [],
      };
      if (
        !c.latest ||
        !c.opening ||
        [c.latest, c.opening].some(
          (b) => !b.complete || b.end > c.asOf || b.receivedAt > c.asOf || b.quality.length,
        )
      )
        return { ...out, conflicts: ['COMPLETED_CANDLES_UNAVAILABLE'] };
      if (c.technical.atr === null) return { ...out, conflicts: ['ATR_HISTORY_INSUFFICIENT'] };
      if ((c.technical.atr / c.latest.close) * 100 > (c.maxAtrPct ?? 3))
        return { ...out, conflicts: ['ATR_VOLATILITY_FILTER'] };
      const result = rule(c);
      if (!result.direction) return { ...out, conflicts: [result.reason] };
      if (c.volume.volumeConfirmationStatus !== 'CONFIRMED')
        return { ...out, conflicts: ['VOLUME_CONFIRMATION_INSUFFICIENT'] };
      const sign = result.direction === 'BULLISH' ? 1 : -1,
        entry = c.latest.close;
      const invalidation =
        sign > 0 ? Math.min(c.latest.low, c.opening.low) : Math.max(c.latest.high, c.opening.high);
      const risk = Math.abs(entry - invalidation);
      if (risk <= 0) return { ...out, conflicts: ['STRUCTURAL_INVALIDATION_UNAVAILABLE'] };
      return {
        ...out,
        direction: result.direction,
        underlyingEntry: entry,
        invalidation,
        target1: entry + sign * risk * 1.5,
        target2: entry + sign * risk * 2,
        reasons: [
          result.reason,
          'Structural invalidation and measured risk targets; unvalidated research hypothesis',
        ],
      };
    },
  };
}
const emaDirection = (c: StrategyContext): Direction | null =>
  c.technical.ema === null || !c.latest
    ? null
    : c.latest.close > c.technical.ema && c.latest.close > c.latest.open
      ? 'BULLISH'
      : c.latest.close < c.technical.ema && c.latest.close < c.latest.open
        ? 'BEARISH'
        : null;
export const advancedStrategies: Strategy[] = [
  make('orb-rvol', broad, (c) =>
    c.latest!.end <= c.opening!.end
      ? { reason: 'POST_OPENING_CANDLE_INSUFFICIENT' }
      : c.latest!.close > c.opening!.high
        ? { direction: 'BULLISH', reason: 'Completed upper opening-range breakout with volume' }
        : c.latest!.close < c.opening!.low
          ? { direction: 'BEARISH', reason: 'Completed lower opening-range breakout with volume' }
          : { reason: 'NO_OPENING_RANGE_BREAKOUT' },
  ),
  make('vwap-continuation', trends, (c) => {
    const v = c.advanced?.vwap,
      d = emaDirection(c);
    if (!v || c.advanced?.instrumentKey !== c.latest!.instrumentKey)
      return { reason: 'COMPARABLE_TRADED_VWAP_UNAVAILABLE' };
    return d === 'BULLISH' && c.latest!.low <= v && c.latest!.close > v
      ? { direction: d, reason: 'VWAP retest and upward continuation' }
      : d === 'BEARISH' && c.latest!.high >= v && c.latest!.close < v
        ? { direction: d, reason: 'VWAP retest and downward continuation' }
        : { reason: 'VWAP_RETEST_NOT_CONFIRMED' };
  }),
  make('volume-ema-trend', trends, (c) => {
    const d = emaDirection(c);
    return d
      ? { direction: d, reason: 'EMA and completed candle direction agree with volume' }
      : { reason: 'EMA_TREND_NOT_CONFIRMED' };
  }),
  make('volume-divergence-reversal', broad, (c) => {
    if (!c.advanced || c.advanced.divergence === 'UNAVAILABLE' || c.technical.rsi === null)
      return { reason: 'DIVERGENCE_HISTORY_INSUFFICIENT' };
    return c.advanced.divergence === 'BULLISH' && c.technical.rsi < 45 && c.latest!.close > c.latest!.open
      ? { direction: 'BULLISH', reason: 'Bullish divergence followed by an upward reversal candle' }
      : c.advanced.divergence === 'BEARISH' && c.technical.rsi > 55 && c.latest!.close < c.latest!.open
        ? { direction: 'BEARISH', reason: 'Bearish divergence followed by a downward reversal candle' }
        : { reason: 'REVERSAL_NOT_CONFIRMED' };
  }),
  make('breakout-failure', broad, (c) =>
    c.advanced?.falseBreakout === 'UPPER_REJECTED' && c.latest!.close < c.latest!.open
      ? { direction: 'BEARISH', reason: 'Upper range rejection and downward confirmation' }
      : c.advanced?.falseBreakout === 'LOWER_REJECTED' && c.latest!.close > c.latest!.open
        ? { direction: 'BULLISH', reason: 'Lower range rejection and upward confirmation' }
        : { reason: c.advanced ? 'BREAKOUT_FAILURE_NOT_CONFIRMED' : 'BREAKOUT_FEATURES_UNAVAILABLE' },
  ),
  make('rsi-bollinger-reversion', ['SIDEWAYS'], (c) => {
    const b = c.technical.bollinger,
      r = c.technical.rsi;
    if (!b || r === null) return { reason: 'OSCILLATOR_HISTORY_INSUFFICIENT' };
    return r < 35 && c.latest!.low < b.lower && c.latest!.close > b.lower && c.latest!.close > c.latest!.open
      ? { direction: 'BULLISH', reason: 'Lower-band rejection with low RSI in a range' }
      : r > 65 && c.latest!.high > b.upper && c.latest!.close < b.upper && c.latest!.close < c.latest!.open
        ? { direction: 'BEARISH', reason: 'Upper-band rejection with high RSI in a range' }
        : { reason: 'MEAN_REVERSION_NOT_CONFIRMED' };
  }),
  make('atr-risk-filter', broad, (c) => {
    const d = emaDirection(c);
    return d
      ? { direction: d, reason: 'ATR filter passed with independent price/EMA/volume confirmation' }
      : { reason: 'DIRECTION_NOT_CONFIRMED' };
  }),
  make('futures-price-volume-oi', trends, (c) => {
    const rows = (c.futureQuotes ?? [])
        .filter((q) => q.sourceTs <= c.asOf && q.receivedAt <= c.asOf)
        .sort((a, b) => a.sourceTs - b.sourceTs),
      a = rows.at(-2),
      b = rows.at(-1),
      d = emaDirection(c);
    if (
      !a ||
      !b ||
      a.oi === null ||
      b.oi === null ||
      a.cumulativeVolume === null ||
      b.cumulativeVolume === null
    )
      return { reason: 'FUTURES_OBSERVATIONS_UNAVAILABLE' };
    if (
      c.asOf - b.sourceTs > 90000 ||
      b.sourceTs - a.sourceTs > 120000 ||
      a.instrumentKey !== b.instrumentKey
    )
      return { reason: 'COMPARABLE_FUTURES_OBSERVATIONS_UNAVAILABLE' };
    if (b.oi <= a.oi || b.cumulativeVolume <= a.cumulativeVolume)
      return { reason: 'FUTURES_ACTIVITY_NOT_CONFIRMED' };
    return d && Math.sign(b.ltp - a.ltp) === (d === 'BULLISH' ? 1 : -1)
      ? {
          direction: d,
          reason:
            'Observed futures price/volume/OI changes align; OI exchange update time and participant intent unknown',
        }
      : { reason: 'FUTURES_DIRECTION_CONFLICT' };
  }),
  make('option-chain-participation', trends, (c) => {
    const rows = (c.optionQuotes ?? []).filter(
        (q) =>
          q.sourceTs <= c.asOf &&
          q.receivedAt <= c.asOf &&
          c.asOf - q.sourceTs <= 15000 &&
          q.ask &&
          q.bid &&
          q.ask >= q.bid &&
          q.oi !== null &&
          q.cumulativeVolume !== null &&
          q.bidQty > 0 &&
          q.askQty > 0,
      ),
      d = emaDirection(c);
    if (!rows.length) return { reason: 'TIMESTAMPED_CHAIN_LIQUIDITY_UNAVAILABLE' };
    return d &&
      rows.some(
        (q) =>
          q.cumulativeVolume! > 0 &&
          q.oi! > 0 &&
          ((q.ask! - q.bid!) / q.ask!) * 100 <= (c.maxSpreadPct ?? 1.5),
      )
      ? {
          direction: d,
          reason: 'Listed option participation with observed depth; no OI buyer/seller inference',
        }
      : { reason: 'OPTION_PARTICIPATION_NOT_CONFIRMED' };
  }),
  make('news-price-volume-response', broad, (c) => {
    const items = (c.news ?? []).filter(
        (n) =>
          n.official &&
          n.publishedAt <= c.latest!.start &&
          n.receivedAt <= c.latest!.start &&
          c.asOf - n.publishedAt <= 86400000 &&
          n.sentiment !== null,
      ),
      d = emaDirection(c);
    if (!items.length) return { reason: 'TIMESTAMP_VALID_OFFICIAL_NEWS_SENTIMENT_UNAVAILABLE' };
    if (items.some((n) => n.sentiment === 'positive') && items.some((n) => n.sentiment === 'negative'))
      return { reason: 'CONFLICTING_NEWS' };
    return d && items.some((n) => n.sentiment === (d === 'BULLISH' ? 'positive' : 'negative'))
      ? {
          direction: d,
          reason: 'Official sourced sentiment followed by independent price and volume confirmation',
        }
      : { reason: 'NEWS_PRICE_RESPONSE_NOT_CONFIRMED' };
  }),
];
