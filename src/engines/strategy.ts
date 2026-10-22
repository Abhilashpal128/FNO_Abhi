import type { Candle, Regime, StrategyDecision, TechnicalFeatures, VolumeFeatures } from '../domain.js';
import type { AdvancedVolume, StrategyAssessment } from '../advanced-domain.js';
import type { Quote, NewsItem } from '../domain.js';
import { advancedStrategies } from './strategies.js';
export interface StrategyContext {
  bars?: Candle[];
  advanced?: AdvancedVolume;
  news?: NewsItem[];
  futureQuotes?: Quote[];
  optionQuotes?: Quote[];
  maxAtrPct?: number;
  maxSpreadPct?: number;
  asOf: number;
  opening: Candle | null;
  latest: Candle | null;
  technical: TechnicalFeatures;
  volume: VolumeFeatures;
  regime: Regime;
}
export interface Strategy {
  id: string;
  version: string;
  regimes: Regime[];
  evaluate(context: StrategyContext): StrategyDecision;
}
export const openingParticipation: Strategy = {
  id: 'opening-participation',
  version: '1.0.0',
  regimes: ['BULLISH_TRENDING', 'BEARISH_TRENDING', 'SIDEWAYS'],
  evaluate(ctx) {
    const out: StrategyDecision = {
      strategyId: this.id,
      version: this.version,
      direction: null,
      underlyingEntry: null,
      invalidation: null,
      target1: null,
      target2: null,
      reasons: [],
      conflicts: [],
    };
    const o = ctx.opening,
      c = ctx.latest;
    if (
      !o ||
      !c ||
      !o.complete ||
      !c.complete ||
      o.end > ctx.asOf ||
      c.end > ctx.asOf ||
      o.receivedAt > ctx.asOf ||
      c.receivedAt > ctx.asOf ||
      o.quality.length ||
      c.quality.length
    ) {
      out.conflicts.push('COMPLETED_OPENING_RANGE_UNAVAILABLE');
      return out;
    }
    const range = o.high - o.low;
    if (range <= 0 || ctx.technical.ema === null || ctx.technical.atr === null) {
      out.conflicts.push('TECHNICAL_HISTORY_INSUFFICIENT');
      return out;
    }
    const atOpening = c.end === o.end;
    const bull =
      (atOpening ? (o.close - o.low) / range >= 0.75 && o.close > o.open : c.close > o.high) &&
      c.close > ctx.technical.ema;
    const bear =
      (atOpening ? (o.close - o.low) / range <= 0.25 && o.close < o.open : c.close < o.low) &&
      c.close < ctx.technical.ema;
    if (!bull && !bear) {
      out.conflicts.push('PRICE_STRUCTURE_NOT_CONFIRMED');
      return out;
    }
    if (ctx.volume.volumeConfirmationStatus !== 'CONFIRMED') {
      out.conflicts.push('VOLUME_GATE_FAILED');
      return out;
    }
    if ((bull && ctx.regime === 'BEARISH_TRENDING') || (bear && ctx.regime === 'BULLISH_TRENDING')) {
      out.conflicts.push('REGIME_CONFLICT');
      return out;
    }
    const sign = bull ? 1 : -1;
    return {
      ...out,
      direction: bull ? 'BULLISH' : 'BEARISH',
      underlyingEntry: c.close,
      invalidation: bull ? o.low : o.high,
      target1: c.close + sign * range * 1.5,
      target2: c.close + sign * range * 2,
      reasons: [
        atOpening
          ? 'Opening candle directional close confirmed by EMA'
          : 'Completed close beyond opening range',
        'Same-time volume participation confirmed',
        'Targets are measured opening-range projections; unvalidated research hypothesis',
      ],
    };
  },
};
/** Baseline for comparisons, using the same as-of data and no volume gate. */
export const emaBaseline: Strategy = {
  id: 'ema-baseline',
  version: '1.0.0',
  regimes: ['BULLISH_TRENDING', 'BEARISH_TRENDING', 'SIDEWAYS'],
  evaluate(ctx) {
    const result = openingParticipation.evaluate({
      ...ctx,
      volume: { ...ctx.volume, volumeConfirmationStatus: 'CONFIRMED' },
    });
    return { ...result, strategyId: this.id, version: this.version };
  },
};
export class StrategyRegistry {
  readonly strategies = new Map<string, Strategy>([
    [openingParticipation.id, openingParticipation],
    [emaBaseline.id, emaBaseline],
    ...advancedStrategies.map((s) => [s.id, s] as [string, Strategy]),
  ]);
  select(regime: Regime): Strategy[] {
    return [...this.strategies.values()].filter((s) => s.id !== 'ema-baseline' && s.regimes.includes(regime));
  }
  assess(context: StrategyContext): StrategyAssessment[] {
    return [...this.strategies.values()]
      .filter((s) => s.id !== 'ema-baseline')
      .map((s) => {
        if (!s.regimes.includes(context.regime))
          return {
            strategyId: s.id,
            version: s.version,
            direction: null,
            underlyingEntry: null,
            invalidation: null,
            target1: null,
            target2: null,
            reasons: [],
            conflicts: [`REGIME_${context.regime}`],
            asOf: context.asOf,
            status: context.regime === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA' : 'REJECTED',
          };
        const d = s.evaluate(context);
        return {
          ...d,
          asOf: context.asOf,
          status: d.direction
            ? 'ELIGIBLE'
            : d.conflicts.some((r) => r.includes('UNAVAILABLE'))
              ? 'DATA_UNAVAILABLE'
              : d.conflicts.some((r) => r.includes('INSUFFICIENT'))
                ? 'INSUFFICIENT_DATA'
                : 'REJECTED',
        };
      });
  }
}
