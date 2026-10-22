import type { Store } from '../db/store.js';
import type { Config } from '../config.js';
import type { Quote, Opportunity } from '../domain.js';
import { OutcomeAccumulator, qualityMetrics, populationStability } from '../engines/evaluation.js';
export class ResearchQualityService {
  private active = new Map<string, OutcomeAccumulator>();
  constructor(
    private store: Store,
    private config: Config,
  ) {}
  register(signal: Opportunity) {
    if (!this.active.has(signal.id))
      this.active.set(
        signal.id,
        new OutcomeAccumulator(
          signal,
          signal.createdAt + this.config.OUTCOME_HORIZON_MINUTES * 60000,
          this.config.QUOTE_MAX_AGE_MS,
        ),
      );
  }
  observe(q: Quote) {
    for (const tracker of this.active.values()) tracker.observe(q);
  }
  async refresh(now: number) {
    const signals = await this.store.find(
      'trade_signals',
      { createdAt: { $gte: now - 86400000 } },
      { limit: 100 },
    );
    for (const signal of signals) {
      const id = `outcome:${signal.id}:${signal.createdAt + this.config.OUTCOME_HORIZON_MINUTES * 60000}`;
      if (await this.store.get('research_outcomes', id)) continue;
      if (!this.active.has(signal.id)) {
        this.register(signal);
        const quotes = await this.store.find(
          'option_snapshots',
          { instrumentKey: signal.contract.id, sourceTs: { $gte: signal.createdAt, $lte: now } },
          { sort: { sourceTs: 1 }, limit: 2000 },
        );
        for (const q of quotes) this.active.get(signal.id)!.observe(q);
      }
      const tracker = this.active.get(signal.id)!;
      if (now < tracker.horizonEnd) continue;
      const filled =
        (await this.store.find('paper_trades', { signalId: signal.id }, { limit: 1 })).length > 0;
      const invalidated =
        (
          await this.store.find(
            'signal_events',
            { signalId: signal.id, status: 'INVALIDATED', timestamp: { $lte: tracker.horizonEnd } },
            { sort: { timestamp: 1 }, limit: 1 },
          )
        )[0]?.timestamp ?? null;
      await this.store.insertMany('research_outcomes', [tracker.finish(now, filled, invalidated)]);
      this.active.delete(signal.id);
    }
  }
  async report() {
    const outcomes = await this.store.find(
        'research_outcomes',
        {},
        { sort: { candidateAt: 1 }, limit: 10000 },
      ),
      trades = await this.store.find(
        'paper_trades',
        { status: 'CLOSED' },
        { sort: { closedAt: 1 }, limit: 10000 },
      );
    return {
      ...qualityMetrics(
        outcomes,
        trades.map((t) => t.pnl ?? 0),
      ),
      grossPnl: trades.reduce((s, t) => s + ((t.exit ?? t.entry) - t.entry) * t.quantity, 0),
      fees: trades.reduce((s, t) => s + t.entryFee + (t.exitFee ?? 0), 0),
      netPnl: trades.reduce((s, t) => s + (t.pnl ?? 0), 0),
      calibrationError: null,
      limitations: [
        'Rule-based screening has no calibrated probability',
        'Sparse quote history after restart may leave outcomes unavailable',
        'Summary reads at most 10,000 records; export for full-history validation',
      ],
    };
  }
  async drift() {
    const signals = await this.store.find('trade_signals', {}, { sort: { createdAt: -1 }, limit: 500 });
    const chronological = signals.reverse();
    const values = chronological.map((s) => s.volume.volumeSpikeRatio).filter((v): v is number => v !== null);
    const mid = Math.floor(values.length / 2);
    return {
      asOf: Date.now(),
      method: 'PSI, reference quantile bins, 0.5 count smoothing',
      feature: 'sameTimeRvol',
      referenceSamples: Math.min(mid, values.length),
      currentSamples: Math.max(0, values.length - mid),
      psi: populationStability(values.slice(0, mid), values.slice(mid)),
      validatedThreshold: null,
    };
  }
}
