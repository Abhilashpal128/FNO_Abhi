import type { Opportunity, Quote, Candle } from '../domain.js';
import type { ResearchOutcome, ValidationSample } from '../advanced-domain.js';
import { fresh } from '../market/time.js';
export function outcomeFromCandles(
  signal: Opportunity,
  rows: Candle[],
  horizonEnd: number,
): ResearchOutcome['status'] {
  for (const c of rows
    .filter(
      (c) =>
        c.instrumentKey === signal.contract.id &&
        c.start >= signal.createdAt &&
        c.end <= horizonEnd &&
        c.receivedAt <= horizonEnd &&
        c.complete &&
        c.quality.length === 0,
    )
    .sort((a, b) => a.start - b.start)) {
    if (c.high >= signal.scenario.target2 && c.low <= signal.scenario.stop) return 'AMBIGUOUS';
    if (c.low <= signal.scenario.stop) return 'STOP_BEFORE_TARGET';
    if (c.high >= signal.scenario.target2) return 'TARGET_BEFORE_STOP';
  }
  return 'DATA_UNAVAILABLE';
}
export class OutcomeAccumulator {
  private last: number;
  private count = 0;
  private maxGap = 0;
  private entry: number | null = null;
  private target: number | null = null;
  private stop: number | null = null;
  private uncertain = false;
  constructor(
    readonly signal: Opportunity,
    readonly horizonEnd: number,
    private maxGapMs: number,
  ) {
    this.last = signal.createdAt;
    this.observe(signal.quote);
  }
  observe(q: Quote) {
    if (
      q.instrumentKey !== this.signal.contract.id ||
      q.sourceTs < this.signal.createdAt ||
      q.sourceTs > this.horizonEnd ||
      q.sourceTs < this.last
    )
      return;
    if (
      !fresh(q.sourceTs, q.receivedAt, q.receivedAt, this.maxGapMs) ||
      q.bid === null ||
      q.ask === null ||
      q.bidQty < this.signal.contract.lotSize ||
      q.askQty < this.signal.contract.lotSize
    )
      return;
    const gap = q.sourceTs - this.last;
    this.maxGap = Math.max(this.maxGap, gap);
    if (gap > this.maxGapMs && this.target === null && this.stop === null) this.uncertain = true;
    this.last = q.sourceTs;
    this.count++;
    if (
      this.entry === null &&
      q.ask >= this.signal.scenario.entryLow &&
      q.ask <= this.signal.scenario.entryHigh
    )
      this.entry = q.sourceTs;
    if (this.target === null && q.bid >= this.signal.scenario.target2) this.target = q.sourceTs;
    if (this.stop === null && q.bid <= this.signal.scenario.stop) this.stop = q.sourceTs;
  }
  finish(asOf: number, paperFilled = false, invalidatedAt: number | null = null): ResearchOutcome {
    if (asOf < this.horizonEnd) throw new Error('Outcome horizon is incomplete');
    const tail = this.horizonEnd - this.last;
    this.maxGap = Math.max(this.maxGap, tail);
    let status: ResearchOutcome['status'];
    if (
      invalidatedAt !== null &&
      (this.target === null || invalidatedAt < this.target) &&
      (this.stop === null || invalidatedAt < this.stop)
    )
      status = 'INVALIDATED';
    else if (this.target !== null && this.stop === this.target) status = 'AMBIGUOUS';
    else if (
      !this.count ||
      this.uncertain ||
      (this.target === null && this.stop === null && tail > this.maxGapMs)
    )
      status = 'DATA_UNAVAILABLE';
    else if (this.entry === null || Math.min(this.target ?? Infinity, this.stop ?? Infinity) < this.entry)
      status = 'ENTRY_NOT_REACHED';
    else if (this.stop !== null && (this.target === null || this.stop < this.target))
      status = 'STOP_BEFORE_TARGET';
    else if (this.target !== null) status = 'TARGET_BEFORE_STOP';
    else status = 'NEITHER_HIT';
    return {
      id: `outcome:${this.signal.id}:${this.horizonEnd}`,
      signalId: this.signal.id,
      candidateAt: this.signal.createdAt,
      horizonEnd: this.horizonEnd,
      evaluatedAt: asOf,
      status,
      entryReachedAt: this.entry,
      targetAt: this.target,
      stopAt: this.stop,
      paperFilled,
      evidenceCount: this.count,
      maxObservationGapMs: this.count ? this.maxGap : null,
      methodology:
        'Observed executable quote target2-before-stop from actual candidate time; research entry condition is separate from a paper fill; pre-outcome observation gaps invalidate labels',
      regime: this.signal.regime,
      strategyId: this.signal.strategy.strategyId,
    };
  }
}
export function chronologicalSplits(rows: ValidationSample[], folds: number, embargoMs: number) {
  const sorted = [...rows].sort((a, b) => a.signalAt - b.signalAt || a.id.localeCompare(b.id));
  if (folds < 1 || !Number.isInteger(folds) || embargoMs < 0) throw new Error('Invalid validation split');
  const width = Math.floor(sorted.length / (folds + 1));
  if (width < 2) return [];
  return Array.from({ length: folds }, (_, i) => {
    const test = sorted.slice((i + 1) * width, i === folds - 1 ? undefined : (i + 2) * width);
    const boundary = test[0]!.signalAt - embargoMs;
    return {
      train: sorted
        .slice(0, (i + 1) * width)
        .filter((r) => r.horizonEnd < boundary && r.availableAt < boundary),
      test,
    };
  });
}
export function calibrationMetrics(labels: number[], probabilities: number[], bins = 10) {
  if (!labels.length || labels.length !== probabilities.length)
    return { brier: null, expectedCalibrationError: null };
  if (
    labels.some((y) => y !== 0 && y !== 1) ||
    probabilities.some((p) => !Number.isFinite(p) || p < 0 || p > 1)
  )
    throw new Error('Invalid calibration inputs');
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const ids = probabilities.flatMap((p, i) => (Math.min(bins - 1, Math.floor(p * bins)) === b ? [i] : []));
    if (ids.length)
      ece +=
        (ids.length / labels.length) *
        Math.abs(
          ids.reduce((s, i) => s + labels[i]!, 0) / ids.length -
            ids.reduce((s, i) => s + probabilities[i]!, 0) / ids.length,
        );
  }
  return {
    brier: labels.reduce((s, y, i) => s + (probabilities[i]! - y) ** 2, 0) / labels.length,
    expectedCalibrationError: ece,
  };
}
export function populationStability(reference: number[], current: number[], bins = 10): number | null {
  if (
    reference.length < 20 ||
    current.length < 20 ||
    [...reference, ...current].some((v) => !Number.isFinite(v))
  )
    return null;
  const sorted = [...reference].sort((a, b) => a - b),
    bounds = Array.from(
      { length: bins - 1 },
      (_, i) => sorted[Math.floor(((i + 1) * sorted.length) / bins)]!,
    );
  const counts = (values: number[]) => {
    const out = Array<number>(bins).fill(0);
    for (const x of values) {
      const i = bounds.findIndex((b) => x <= b);
      out[i < 0 ? bins - 1 : i]!++;
    }
    return out.map((n) => (n + 0.5) / (values.length + 0.5 * bins));
  };
  const a = counts(reference),
    b = counts(current);
  return a.reduce((s, p, i) => s + (b[i]! - p) * Math.log(b[i]! / p), 0);
}
export function qualityMetrics(outcomes: ResearchOutcome[], pnls: number[] = []) {
  const labeled = outcomes.filter((o) =>
    ['TARGET_BEFORE_STOP', 'STOP_BEFORE_TARGET', 'NEITHER_HIT'].includes(o.status),
  );
  const targets = labeled.filter((o) => o.status === 'TARGET_BEFORE_STOP').length;
  let streak = 0,
    worst = 0;
  for (const p of pnls) {
    streak = p < 0 ? streak + 1 : 0;
    worst = Math.max(worst, streak);
  }
  return {
    eligibleOpportunities: outcomes.length,
    labeledOpportunities: labeled.length,
    signalCoverage: outcomes.length ? labeled.length / outcomes.length : null,
    targetBeforeStopAccuracy: labeled.length ? targets / labeled.length : null,
    ambiguous: outcomes.filter((o) => o.status === 'AMBIGUOUS').length,
    unavailable: outcomes.filter((o) => o.status === 'DATA_UNAVAILABLE').length,
    averageWin: pnls.some((p) => p > 0)
      ? pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0) / pnls.filter((p) => p > 0).length
      : null,
    averageLoss: pnls.some((p) => p < 0)
      ? pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0) / pnls.filter((p) => p < 0).length
      : null,
    worstLosingStreak: worst,
    byRegime: Object.fromEntries(
      [...new Set(outcomes.map((o) => o.regime))].map((regime) => {
        const rows = labeled.filter((o) => o.regime === regime);
        return [
          regime,
          {
            count: rows.length,
            targetBeforeStopAccuracy: rows.length
              ? rows.filter((o) => o.status === 'TARGET_BEFORE_STOP').length / rows.length
              : null,
          },
        ];
      }),
    ),
  };
}
