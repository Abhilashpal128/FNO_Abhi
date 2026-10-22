import type { Config } from '../config.js';
import type { Instrument, Quote, RiskSettings, Scenario, StrategyDecision, PaperTrade } from '../domain.js';
import { daysUntil, dayKey, fresh } from '../market/time.js';
export function roundTick(price: number, tick: number, direction: 'up' | 'down' = 'up'): number {
  return Number(
    ((direction === 'up' ? Math.ceil(price / tick - 1e-8) : Math.floor(price / tick + 1e-8)) * tick).toFixed(
      8,
    ),
  );
}
export function spread(q: Quote): { absolute: number | null; percentage: number | null } {
  if (q.bid === null || q.ask === null || q.bid <= 0 || q.ask < q.bid)
    return { absolute: null, percentage: null };
  return { absolute: q.ask - q.bid, percentage: ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100 };
}
export function charges(price: number, quantity: number, side: 'BUY' | 'SELL', c: Config): number {
  const turnover = price * quantity,
    exchange = turnover * c.EXCHANGE_FEE_RATE,
    sebi = turnover * c.SEBI_FEE_RATE;
  return (
    c.BROKERAGE_PER_ORDER +
    exchange +
    sebi +
    (c.BROKERAGE_PER_ORDER + exchange + sebi) * c.GST_RATE +
    turnover * (side === 'BUY' ? c.STAMP_BUY_RATE : c.STT_SELL_RATE)
  );
}
export function liquidityRejections(contract: Instrument, q: Quote, now: number, c: Config): string[] {
  const reasons: string[] = [],
    s = spread(q);
  if (contract.id !== q.instrumentKey) reasons.push('CONTRACT_QUOTE_MISMATCH');
  if (
    !fresh(q.sourceTs, q.receivedAt, now, c.QUOTE_MAX_AGE_MS) ||
    !fresh(q.lastTradeTs, q.receivedAt, now, c.QUOTE_MAX_AGE_MS)
  )
    reasons.push('STALE_QUOTE');
  if (q.quality.some((flag) => !['OI_UPDATE_TIMESTAMP_UNAVAILABLE'].includes(flag)))
    reasons.push('QUOTE_QUALITY_FAILED');
  if (s.percentage === null || s.percentage > c.MAX_SPREAD_PCT) reasons.push('SPREAD_TOO_WIDE_OR_MISSING');
  if (q.askQty < contract.lotSize || q.bidQty < contract.lotSize) reasons.push('INSUFFICIENT_ONE_LOT_DEPTH');
  if (q.cumulativeVolume === null || q.cumulativeVolume < c.MIN_OPTION_VOLUME)
    reasons.push('OPTION_VOLUME_TOO_LOW');
  return reasons;
}
export function buildScenario(
  contract: Instrument,
  q: Quote,
  decision: StrategyDecision,
  c: Config,
): Scenario | null {
  if (
    q.ask === null ||
    q.bid === null ||
    q.delta === null ||
    q.gamma === null ||
    q.theta === null ||
    q.iv === null ||
    q.iv <= 0 ||
    Math.abs(q.delta) < 0.25 ||
    Math.abs(q.delta) > 0.8 ||
    q.gamma < 0 ||
    decision.underlyingEntry === null ||
    decision.invalidation === null ||
    decision.target1 === null ||
    decision.target2 === null ||
    contract.tickSize <= 0
  )
    return null;
  if ((contract.kind === 'CE' && q.delta <= 0) || (contract.kind === 'PE' && q.delta >= 0)) return null;
  const tick = contract.tickSize,
    entry = roundTick(q.ask * (1 + c.SLIPPAGE_BPS / 10000), tick, 'up');
  const underlying = decision.underlyingEntry;
  const moves = [decision.invalidation, decision.target1, decision.target2].map((p) => p - underlying);
  if (moves.some((m) => Math.abs(m) / underlying > 0.03)) return null;
  // Local delta/gamma approximation maps underlying structure to premium, not fixed premium percentages.
  const premium = (move: number) =>
    q.bid! + q.delta! * move + 0.5 * q.gamma! * move * move - (Math.abs(q.theta ?? 0) * 15) / (24 * 60);
  const stop = roundTick(premium(moves[0]!), tick, 'down'),
    target1 = roundTick(premium(moves[1]!), tick, 'down'),
    target2 = roundTick(premium(moves[2]!), tick, 'down');
  if (stop <= 0 || stop >= entry || target1 <= entry || target2 <= target1) return null;
  const qty = contract.lotSize,
    estimatedCosts =
      charges(entry, qty, 'BUY', c) + charges(stop, qty, 'SELL', c) + (stop * qty * c.SLIPPAGE_BPS) / 10000;
  const loss = (entry - stop) * qty + estimatedCosts,
    reward =
      (target1 - entry) * qty -
      charges(entry, qty, 'BUY', c) -
      charges(target1, qty, 'SELL', c) -
      (target1 * qty * c.SLIPPAGE_BPS) / 10000;
  return {
    entryLow: roundTick(q.ask, tick, 'up'),
    entryHigh: entry,
    stop,
    target1,
    target2,
    quantity: qty,
    oneLotCapital: entry * qty + charges(entry, qty, 'BUY', c),
    plannedLoss: loss,
    estimatedCosts,
    rewardRisk: reward / loss,
    methodology:
      'structure-delta-gamma-v1; local Greek projection of measured opening range; 15-minute theta stress; conservative bid/ask and slippage; not a validated price forecast',
    underlyingInvalidation: decision.invalidation,
  };
}
export function defaultRisk(c: Config, now: number): RiskSettings {
  return {
    id: 'owner',
    globalNoTrade: c.GLOBAL_NO_TRADE,
    maxRiskPerTrade: c.MAX_RISK_PER_TRADE,
    maxDailyLoss: c.MAX_DAILY_LOSS,
    maxAggregateRisk: c.MAX_AGGREGATE_RISK,
    maxCorrelatedRisk: c.MAX_CORRELATED_RISK,
    maxDailyOpportunities: c.MAX_DAILY_OPPORTUNITIES,
    updatedAt: now,
  };
}
export interface RiskContext {
  now: number;
  settings: RiskSettings;
  dailyLoss: number;
  aggregateRisk: number;
  correlatedRisk: number;
  availableCash: number;
  dailyCount: number;
  highImpactEvent: boolean;
  eventCalendarReady: boolean;
}
export function riskRejections(
  contract: Instrument,
  q: Quote,
  scenario: Scenario,
  ctx: RiskContext,
  c: Config,
): string[] {
  const r = liquidityRejections(contract, q, ctx.now, c),
    s = ctx.settings;
  if (c.GLOBAL_NO_TRADE || s.globalNoTrade) r.push('GLOBAL_NO_TRADE');
  if (
    !contract.active ||
    !['CE', 'PE'].includes(contract.kind) ||
    !contract.expiry ||
    contract.lotSize < 1 ||
    !Number.isInteger(contract.lotSize) ||
    contract.strike === null
  )
    r.push('INVALID_CONTRACT');
  if (dayKey(contract.asOf) !== dayKey(ctx.now) && contract.mode !== 'demo')
    r.push('STALE_INSTRUMENT_MASTER');
  const days = contract.expiry ? daysUntil(dayKey(ctx.now), contract.expiry) : -1;
  if (
    !Number.isFinite(days) ||
    days < c.MIN_EXPIRY_DAYS ||
    (contract.underlyingType === 'EQUITY' && days <= c.STOCK_EXPIRY_BUFFER_DAYS)
  )
    r.push('EXPIRY_OR_PHYSICAL_SETTLEMENT_RESTRICTION');
  if (
    !Number.isFinite(scenario.plannedLoss) ||
    scenario.plannedLoss <= 0 ||
    scenario.plannedLoss > s.maxRiskPerTrade
  )
    r.push('TRADE_RISK_BUDGET');
  if (ctx.dailyLoss >= s.maxDailyLoss || ctx.dailyLoss + scenario.plannedLoss > s.maxDailyLoss)
    r.push('DAILY_LOSS_BUDGET');
  if (ctx.aggregateRisk + scenario.plannedLoss > s.maxAggregateRisk) r.push('AGGREGATE_RISK_BUDGET');
  if (ctx.correlatedRisk + scenario.plannedLoss > s.maxCorrelatedRisk) r.push('CORRELATED_RISK_BUDGET');
  if (ctx.availableCash < scenario.oneLotCapital) r.push('CAPITAL_BUDGET');
  if (ctx.dailyCount >= Math.min(5, s.maxDailyOpportunities)) r.push('DAILY_OPPORTUNITY_LIMIT');
  if (scenario.rewardRisk < c.MIN_REWARD_RISK) r.push('REWARD_RISK_TOO_LOW');
  if (ctx.highImpactEvent) r.push('HIGH_IMPACT_EVENT');
  if (c.REQUIRE_EVENT_CALENDAR && !ctx.eventCalendarReady && c.DATA_MODE === 'live')
    r.push('EVENT_CALENDAR_UNAVAILABLE');
  if (!c.COSTS_VERIFIED && c.DATA_MODE === 'live') r.push('COST_ASSUMPTIONS_UNVERIFIED');
  if (c.DATA_MODE === 'live' && (q.mode !== 'live' || contract.mode !== 'live')) r.push('NON_LIVE_DATA');
  return [...new Set(r)];
}
export function positionRisk(trades: PaperTrade[], day: string, group: string) {
  const open = trades.filter((t) => t.status === 'OPEN');
  return {
    dailyLoss: trades
      .filter((t) => t.status === 'CLOSED' && t.closedAt !== null && dayKey(t.closedAt) === day)
      .reduce((s, t) => s + Math.max(0, -(t.pnl ?? 0)), 0),
    aggregateRisk: open.reduce((s, t) => s + t.plannedRisk, 0),
    correlatedRisk: open.filter((t) => t.correlationGroup === group).reduce((s, t) => s + t.plannedRisk, 0),
  };
}
