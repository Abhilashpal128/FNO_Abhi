import type {
  BacktestTrade,
  Candle,
  Instrument,
  Performance,
  Quote,
  VolumeProfile,
  BacktestRun,
  Regime,
  InstrumentVersion,
  EventCalendarVersion,
  MarketSession,
  NewsItem,
} from '../domain.js';
import type { Config } from '../config.js';
import { dayKey, atIST, MINUTE, fresh } from '../market/time.js';
import { aggregateCandles } from '../market/candles.js';
import { technicalFeatures, marketRegime } from './indicators.js';
import { volumeIntelligence } from './volume.js';
import { emaBaseline, StrategyRegistry, type Strategy } from './strategy.js';
import { advancedVolume } from './advanced-volume.js';
import {
  buildScenario,
  charges,
  defaultRisk,
  liquidityRejections,
  riskRejections,
  roundTick,
} from './risk.js';
export function performance(pnls: number[]): Performance {
  let equity = 0,
    peak = 0,
    maxDrawdown = 0;
  for (const p of pnls) {
    equity += p;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const wins = pnls.filter((p) => p > 0),
    losses = pnls.filter((p) => p < 0),
    grossProfit = wins.reduce((a, b) => a + b, 0),
    grossLoss = -losses.reduce((a, b) => a + b, 0);
  return {
    trades: pnls.length,
    netPnl: equity,
    winRate: pnls.length ? wins.length / pnls.length : null,
    expectancy: pnls.length ? equity / pnls.length : null,
    maxDrawdown,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
  };
}
export function asOfCandles(rows: Candle[], asOf: number): Candle[] {
  return rows
    .filter((c) => c.complete && c.end <= asOf && c.receivedAt <= asOf)
    .sort((a, b) => a.start - b.start);
}
export function conservativeCandleExit(
  c: Candle,
  stop: number,
  target: number,
): { price: number; reason: string } | null {
  if (c.low <= stop && c.high >= target)
    return { price: Math.min(c.open, stop), reason: 'AMBIGUOUS_BOTH_TOUCHED_STOP_FIRST' };
  if (c.low <= stop) return { price: Math.min(c.open, stop), reason: 'STOP' };
  if (c.high >= target) return { price: target, reason: 'TARGET' };
  return null;
}
export interface ReplayDataset {
  underlying: Instrument;
  contract: Instrument;
  underlyingCandles: Candle[];
  volumeCandles: Candle[];
  profiles: VolumeProfile[];
  quotes: Quote[];
  from: number;
  to: number;
  id: string;
  createdAt: number;
  eventCalendarReady: boolean;
  instrumentVersions?: InstrumentVersion[];
  eventCalendars?: EventCalendarVersion[];
  sessions?: MarketSession[];
  news?: NewsItem[];
  futureQuotes?: Quote[];
  strategyId?: string;
}
function replay(
  dataset: ReplayDataset,
  c: Config,
  strategy: Strategy | null,
  ablation: { volume: boolean; news: boolean } = { volume: true, news: true },
): {
  trades: BacktestTrade[];
  limitations: string[];
  counts: { decisions: number; eligible: number; filled: number; noFill: number; unresolved: number };
} {
  const counts = { decisions: 0, eligible: 0, filled: 0, noFill: 0, unresolved: 0 },
    registry = new StrategyRegistry();
  const trades: BacktestTrade[] = [],
    limitations = new Set<string>();
  const days = [
    ...new Set(
      dataset.underlyingCandles
        .filter((b) => b.end >= dataset.from && b.end <= dataset.to)
        .map((b) => dayKey(b.start)),
    ),
  ];
  days.sort();
  const quotes = [...dataset.quotes]
    .filter(
      (q) =>
        q.instrumentKey === dataset.contract.id && q.sourceTs <= dataset.to && q.receivedAt <= dataset.to,
    )
    .sort((a, b) => a.sourceTs - b.sourceTs);
  for (const day of days) {
    const session = dataset.sessions?.find((s) => s.day === day);
    if (c.DATA_MODE === 'live' && (!session?.verified || !session.trading)) {
      limitations.add('Verified historical exchange session unavailable');
      continue;
    }
    const open = session?.open ?? atIST(day, '09:15'),
      close = session?.close ?? atIST(day, '15:30');
    let entered = false;
    for (let decisionAt = open + 5 * MINUTE; decisionAt < close && !entered; decisionAt += 15 * MINUTE) {
      if (decisionAt < dataset.from || decisionAt > dataset.to) continue;
      const asOf = decisionAt + 2000;
      if (asOf > dataset.to) continue;
      const version = (key: string, fallback: Instrument) =>
        (dataset.instrumentVersions ?? [])
          .filter((v) => v.instrumentKey === key && v.asOf <= asOf)
          .sort((a, b) => b.asOf - a.asOf)[0]?.instrument ?? fallback;
      const contract = version(dataset.contract.id, dataset.contract),
        underlying = version(dataset.underlying.id, dataset.underlying);
      if (contract.asOf > asOf || underlying.asOf > asOf) {
        limitations.add('Point-in-time instrument metadata unavailable');
        continue;
      }
      const calendar = dataset.eventCalendars
        ?.filter((v) => v.receivedAt <= asOf && v.validFrom <= day && v.validUntil >= day)
        .sort((a, b) => b.receivedAt - a.receivedAt)[0];
      const highImpact =
        calendar?.events.some(
          (e) =>
            e.impact === 'HIGH' &&
            e.publishedAt <= asOf &&
            e.receivedAt <= asOf &&
            e.start <= asOf + 30 * MINUTE &&
            e.end >= asOf &&
            (e.instrumentKeys.length === 0 || e.instrumentKeys.includes(underlying.id)),
        ) ?? false;
      const rows = asOfCandles(dataset.underlyingCandles, asOf),
        volumeRows = asOfCandles(dataset.volumeCandles, asOf);
      const opening = aggregateCandles(rows, 5, open, asOf),
        latest = aggregateCandles(rows, 5, decisionAt - 5 * MINUTE, asOf);
      const volumeOpening = aggregateCandles(volumeRows, 5, open, asOf),
        volumeLatest = aggregateCandles(volumeRows, 5, decisionAt - 5 * MINUTE, asOf);
      if (!latest || !opening) {
        limitations.add('Missing completed underlying candles');
        continue;
      }
      const features = volumeIntelligence(
          volumeLatest,
          volumeOpening,
          volumeRows.filter((b) => b.start >= open),
          dataset.profiles,
          asOf,
          c,
        ),
        technical = technicalFeatures(rows, asOf),
        regime = marketRegime(technical, latest.close, highImpact, c.MAX_ATR_PCT);
      counts.decisions++;
      const advanced = advancedVolume(volumeRows, dataset.profiles, asOf, c, volumeOpening);
      const context = {
        asOf,
        opening,
        latest,
        technical,
        volume: ablation.volume
          ? features
          : { ...features, volumeConfirmationStatus: 'CONFIRMED' as const, dataQualityFlags: [] },
        regime,
        bars: rows,
        advanced: ablation.volume ? advanced : undefined,
        news: ablation.news
          ? (dataset.news ?? []).filter((n) => n.publishedAt <= asOf && n.receivedAt <= asOf)
          : [],
        futureQuotes: ablation.volume ? dataset.futureQuotes?.filter((q) => q.sourceTs <= asOf && q.receivedAt <= asOf) : [],
        optionQuotes: ablation.volume ? quotes.filter((q) => q.sourceTs <= asOf && q.receivedAt <= asOf).slice(-12) : [],
        maxAtrPct: c.MAX_ATR_PCT,
        maxSpreadPct: c.MAX_SPREAD_PCT,
      };
      if (strategy && !strategy.regimes.includes(regime)) continue;
      const decision = strategy
        ? strategy.evaluate(context)
        : registry
            .assess(context)
            .find(
              (d) => d.direction !== null && (!dataset.strategyId || d.strategyId === dataset.strategyId),
            );
      if (!decision) continue;
      if (!decision.direction) continue;
      if (contract.kind !== (decision.direction === 'BULLISH' ? 'CE' : 'PE')) continue;
      const original = quotes.filter((q) => q.sourceTs <= asOf && q.receivedAt <= asOf).at(-1);
      if (!original) {
        limitations.add(
          'No recorded executable option quote at decision; expired OHLC alone is insufficient',
        );
        continue;
      }
      const scenario = buildScenario(contract, original, decision, c);
      if (!scenario) continue;
      const dailyLoss = trades
          .filter((t) => dayKey(t.exitAt) === day)
          .reduce((s, t) => s + Math.max(0, -t.pnl), 0),
        cash = c.SIMULATED_CAPITAL + trades.reduce((s, t) => s + t.pnl, 0);
      const reasons = riskRejections(
        contract,
        original,
        scenario,
        {
          now: asOf,
          settings: defaultRisk(c, asOf),
          dailyLoss,
          aggregateRisk: 0,
          correlatedRisk: 0,
          availableCash: cash,
          dailyCount: 0,
          highImpactEvent: highImpact,
          eventCalendarReady: !!calendar || (c.DATA_MODE === 'demo' && dataset.eventCalendarReady),
        },
        c,
      );
      if (reasons.length) {
        limitations.add(`Risk gates: ${reasons.join(',')}`);
        continue;
      }
      counts.eligible++;
      // First observed executable ask AFTER decision, never the signal candle close.
      const fill = quotes.find(
        (q) =>
          q.sourceTs > asOf &&
          q.receivedAt >= q.sourceTs &&
          q.receivedAt <= asOf + MINUTE &&
          q.ask !== null &&
          q.ask <= scenario.entryHigh &&
          q.ask >= scenario.entryLow &&
          liquidityRejections(contract, q, q.receivedAt, c).length === 0,
      );
      if (!fill || fill.ask === null) {
        counts.noFill++;
        limitations.add('Entry had no next-quote fill within one minute');
        continue;
      }
      const entry = roundTick(fill.ask * (1 + c.SLIPPAGE_BPS / 10000), contract.tickSize, 'up');
      if (entry > scenario.entryHigh) continue;
      counts.filled++;
      let exitQuote: Quote | undefined,
        reason = '';
      let lastObserved = fill.sourceTs,
        gap = false;
      for (const q of quotes) {
        if (
          q.sourceTs <= fill.sourceTs ||
          q.sourceTs > Math.min(close, dataset.to) ||
          q.receivedAt > dataset.to ||
          q.bid === null ||
          q.bidQty < contract.lotSize ||
          !fresh(q.sourceTs, q.receivedAt, q.receivedAt, c.QUOTE_MAX_AGE_MS) ||
          !fresh(q.lastTradeTs, q.receivedAt, q.receivedAt, c.QUOTE_MAX_AGE_MS)
        )
          continue;
        if (q.sourceTs - lastObserved > c.QUOTE_MAX_AGE_MS) {
          gap = true;
          break;
        }
        lastObserved = q.sourceTs;
        if (q.bid <= scenario.stop) {
          exitQuote = q;
          reason = 'STOP';
          break;
        }
        if (q.bid >= scenario.target2) {
          exitQuote = q;
          reason = 'TARGET_2';
          break;
        }
        if (q.sourceTs >= close - MINUTE) {
          exitQuote = q;
          reason = 'SESSION_CLOSE';
          break;
        }
      }
      entered = true;
      if (!exitQuote || exitQuote.bid === null) {
        counts.unresolved++;
        limitations.add(
          gap
            ? 'Open outcome unresolved: observation gap can hide a stop/target; excluded from completed-trade metrics'
            : 'Open outcome unresolved: no executable exit quote; excluded from completed-trade metrics',
        );
        return { trades, limitations: [...limitations], counts };
      }
      const exit = roundTick(exitQuote.bid * (1 - c.SLIPPAGE_BPS / 10000), contract.tickSize, 'down'),
        qty = contract.lotSize;
      trades.push({
        signalAt: asOf,
        entryAt: fill.sourceTs,
        exitAt: exitQuote.sourceTs,
        entry,
        exit,
        quantity: qty,
        pnl: (exit - entry) * qty - charges(entry, qty, 'BUY', c) - charges(exit, qty, 'SELL', c),
        grossPnl: (exitQuote.bid - fill.ask) * qty,
        fees: charges(entry, qty, 'BUY', c) + charges(exit, qty, 'SELL', c),
        slippage: (entry - fill.ask + (exitQuote.bid - exit)) * qty,
        reason,
        regime,
      });
    }
  }
  return { trades, limitations: [...limitations], counts };
}
export function runBacktest(dataset: ReplayDataset, c: Config): BacktestRun {
  const main = replay(dataset, c, null),
    baseline = replay(dataset, c, emaBaseline);
  const withoutVolume = replay(dataset, c, null, { volume: false, news: true }),
    withoutNews = replay(dataset, c, null, { volume: true, news: false }),
    withoutBoth = replay(dataset, c, null, { volume: false, news: false });
  const pnls = main.trades.map((t) => t.pnl),
    wins = pnls.filter((p) => p > 0),
    losses = pnls.filter((p) => p < 0);
  let streak = 0,
    worst = 0;
  for (const p of pnls) {
    streak = p < 0 ? streak + 1 : 0;
    worst = Math.max(worst, streak);
  }
  return {
    id: dataset.id,
    createdAt: dataset.createdAt,
    status: main.trades.length ? 'COMPLETE' : 'INSUFFICIENT_DATA',
    from: dataset.from,
    to: dataset.to,
    mode: dataset.contract.mode,
    strategyVersion: dataset.strategyId ? `${dataset.strategyId}:1.0.0` : 'registry:2.0.0',
    metrics: performance(main.trades.map((t) => t.pnl)),
    trades: main.trades,
    limitations: [
      ...main.limitations,
      'Strict recorded receivedAt cutoff; downloaded-later candles cannot reconstruct a point-in-time decision',
      'Only recorded contracts and quote depth are replayed; no fabricated expired premium or spread',
      'Single-underlying/contract replay; portfolio correlations and cross-contract execution require forward evaluation',
      'Baseline removes volume confirmation; all cost, time and risk gates remain active',
    ],
    baseline: performance(baseline.trades.map((t) => t.pnl)),
    ablations: {
      withoutVolume: performance(withoutVolume.trades.map((t) => t.pnl)),
      withoutNews: performance(withoutNews.trades.map((t) => t.pnl)),
      withoutVolumeOrNews: performance(withoutBoth.trades.map((t) => t.pnl)),
    },
    evaluation: {
      ...main.counts,
      grossPnl: main.trades.reduce((s, t) => s + (t.grossPnl ?? 0), 0),
      feesAndSlippage: main.trades.reduce((s, t) => s + (t.fees ?? 0) + (t.slippage ?? 0), 0),
      averageWin: wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null,
      averageLoss: losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null,
      worstLosingStreak: worst,
      coverage: main.counts.decisions ? main.counts.eligible / main.counts.decisions : null,
    },
  };
}
export function regimePerformance(trades: BacktestTrade[]): Partial<Record<Regime, Performance>> {
  return Object.fromEntries(
    [...new Set(trades.map((t) => t.regime))].map((r) => [
      r,
      performance(trades.filter((t) => t.regime === r).map((t) => t.pnl)),
    ]),
  );
}
