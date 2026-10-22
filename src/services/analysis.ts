import { createHash, randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { AnalysisRun, Instrument, Opportunity, Quote, SignalEvent, VolumeFeatures } from '../domain.js';
import type { Store } from '../db/store.js';
import { ConflictError } from '../db/store.js';
import type { MarketService } from './market.js';
import type { NewsService } from './news.js';
import { dayKey, fresh, MINUTE, nextAnalysis } from '../market/time.js';
import { volumeIntelligence, VolumeCandidateFilter } from '../engines/volume.js';
import { technicalFeatures, marketRegime } from '../engines/indicators.js';
import { StrategyRegistry } from '../engines/strategy.js';
import { advancedVolume } from '../engines/advanced-volume.js';
import type { ResearchQualityService } from './quality.js';
import { buildScenario, defaultRisk, positionRisk, riskRejections, spread } from '../engines/risk.js';
export const terminalStatuses = new Set(['TARGET_2_HIT', 'STOPPED', 'EXPIRED', 'INVALIDATED', 'REJECTED']);
export function correlationGroup(_i: Instrument): string {
  return 'INDIA_EQUITY';
} // Conservative shared group until independently validated sector correlation data is configured.
export function rankCandidates(candidates: Opportunity[]): Opportunity[] {
  return [...candidates].sort(
    (a, b) =>
      b.ranking.rvol - a.ranking.rvol ||
      b.ranking.rewardRisk - a.ranking.rewardRisk ||
      a.ranking.spreadPct - b.ranking.spreadPct ||
      a.contract.id.localeCompare(b.contract.id),
  );
}
export function snapshotHash(value: Omit<Opportunity, 'snapshotHash'> | Opportunity): string {
  const { snapshotHash: _hash, ...original } = value as Opportunity;
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, item]) => [k, canonical(item)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(original)))
    .digest('hex');
}
export async function latestEvent(store: Store, signalId: string): Promise<SignalEvent | null> {
  return (await store.find('signal_events', { signalId }, { sort: { timestamp: -1 }, limit: 1 }))[0] ?? null;
}
export async function riskExposure(store: Store, market: MarketService, now: number, excludeSignal?: string) {
  const day = dayKey(now),
    trades = await store.find('paper_trades'),
    position = positionRisk(trades, day, 'INDIA_EQUITY');
  const traded = new Set(trades.map((t) => t.signalId));
  let reserved = 0,
    reservedCapital = 0;
  for (const s of await store.find('trade_signals', { day, expiresAt: { $gt: now } })) {
    if (
      s.id === excludeSignal ||
      traded.has(s.id) ||
      terminalStatuses.has((await latestEvent(store, s.id))?.status ?? '')
    )
      continue;
    reserved += s.scenario.plannedLoss;
    reservedCapital += s.scenario.oneLotCapital;
  }
  let unrealizedLoss = 0;
  for (const t of trades.filter((t) => t.status === 'OPEN')) {
    const q = market.quotes.get(t.instrumentKey);
    const mark =
      q && q.bid !== null && fresh(q.sourceTs, q.receivedAt, now, market.config.QUOTE_MAX_AGE_MS) ? q.bid : 0;
    unrealizedLoss += Math.max(0, (t.entry - mark) * t.quantity + t.entryFee);
  }
  return {
    ...position,
    dailyLoss: position.dailyLoss + unrealizedLoss,
    aggregateRisk: position.aggregateRisk + reserved,
    correlatedRisk: position.correlatedRisk + reserved,
    reservedCapital,
  };
}
export class AnalysisService {
  quality?: ResearchQualityService;
  readonly registry = new StrategyRegistry();
  constructor(
    readonly store: Store,
    readonly market: MarketService,
    readonly news: NewsService,
    readonly config: Config,
  ) {}
  async initialize(now: number) {
    const mode = await this.store.get('system_health', 'database-mode');
    if (mode && mode.details[0] !== this.config.DATA_MODE)
      throw new Error('Use separate MongoDB databases for demo and live data');
    if (!mode)
      await this.store.put('system_health', {
        id: 'database-mode',
        status: 'OK',
        checkedAt: now,
        details: [this.config.DATA_MODE],
      });
    if (!(await this.store.get('private_accounts', 'owner')))
      try {
        await this.store.insert('private_accounts', {
          id: 'owner',
          capital: this.config.SIMULATED_CAPITAL,
          cash: this.config.SIMULATED_CAPITAL,
          realizedPnl: 0,
          updatedAt: now,
          revision: 0,
        });
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    if (!(await this.store.get('risk_settings', 'owner')))
      await this.store.put('risk_settings', defaultRisk(this.config, now));
    for (const strategy of this.registry.strategies.values()) {
      const record = {
        id: `${strategy.id}:${strategy.version}`,
        name: strategy.id,
        version: strategy.version,
        createdAt: now,
        validated: false,
        details: {
          regimes: strategy.regimes,
          probability: null,
          validation: 'Requires chronological historical and forward validation',
        },
      };
      await this.store.put('strategy_definitions', record);
      if (!(await this.store.get('strategy_versions', record.id)))
        try {
          await this.store.insert('strategy_versions', record);
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
        }
    }
  }
  async evaluate(
    kind: AnalysisRun['kind'],
    scheduledFor: number,
    now: number,
    id: string = randomUUID(),
  ): Promise<AnalysisRun> {
    const previous = await this.store.get('analysis_runs', id);
    if (previous) return previous;
    const day = dayKey(now),
      session = this.market.session;
    const run: AnalysisRun = {
      id,
      day,
      scheduledFor,
      analyzedAt: now,
      kind,
      status: 'INSUFFICIENT_DATA',
      mode: this.config.DATA_MODE,
      signalIds: [],
      activeSignalIds: [],
      signalStatuses: [],
      rejections: [],
      qualityLimitations: [],
      dataFreshness: {
        newestQuoteAt: null,
        oldestRequiredQuoteAt: null,
        maxAgeMs: this.config.QUOTE_MAX_AGE_MS,
        status: this.config.DATA_MODE === 'demo' ? 'DEMO' : 'UNAVAILABLE',
      },
      nextScheduledAt: session ? nextAnalysis(session, now) : null,
      volume: [],
    };
    const candidates: Opportunity[] = [],
      requiredQuotes: Quote[] = [];
    if (this.config.DATA_MODE === 'demo')
      run.qualityLimitations.push('SYNTHETIC_DEMO_DATA_NOT_MARKET_RESEARCH');
    run.qualityLimitations.push(
      'Strategy and Greek premium projections are unvalidated hypotheses; calibrated probability unavailable',
      'Stop fills and planned loss are not guaranteed',
      'OI source update time unavailable; no buyer/seller intent inferred',
    );
    const sessionReady =
      session &&
      session.day === day &&
      session.trading &&
      (session.verified || this.config.DATA_MODE === 'demo') &&
      now >= session.open + 5 * MINUTE &&
      now < session.close;
    if (!sessionReady)
      run.qualityLimitations.push('VERIFIED_OPEN_SESSION_OR_COMPLETED_OPENING_WINDOW_UNAVAILABLE');
    else
      for (const underlying of this.market.underlyings) {
        const key = underlying.id,
          volumeKey = this.market.volumeKeys.get(key),
          uq = this.market.quotes.get(key);
        if (!volumeKey || !uq || !fresh(uq.sourceTs, uq.receivedAt, now, this.config.QUOTE_MAX_AGE_MS)) {
          run.rejections.push({
            instrumentKey: key,
            reasons: ['UNDERLYING_PRICE_OR_TRADED_VOLUME_PROXY_UNAVAILABLE'],
          });
          continue;
        }
        requiredQuotes.push(uq);
        const modes = this.config.DATA_MODE === 'demo' ? ['demo'] : ['live', 'historical'];
        const bars = await this.store.find(
          'market_candles',
          { instrumentKey: key, interval: 1, end: { $lte: now }, mode: { $in: modes } },
          { sort: { start: -1 }, limit: 250 },
        );
        bars.reverse();
        const opening =
          (
            await this.store.find(
              'market_candles',
              {
                instrumentKey: key,
                interval: 5,
                start: session.open,
                complete: true,
                receivedAt: { $lte: now },
                mode: { $in: modes },
              },
              { limit: 1 },
            )
          )[0] ?? null;
        const latest =
          (
            await this.store.find(
              'market_candles',
              {
                instrumentKey: key,
                interval: 5,
                start: { $gte: session.open },
                end: { $lte: now },
                complete: true,
                receivedAt: { $lte: now },
                mode: { $in: modes },
              },
              { sort: { start: -1 }, limit: 1 },
            )
          )[0] ?? null;
        if (!latest || now - latest.end > 6 * MINUTE) {
          run.rejections.push({
            instrumentKey: key,
            reasons: ['LATEST_COMPLETED_CANDLE_UNAVAILABLE_OR_STALE'],
          });
          continue;
        }
        const volumeBars = await this.store.find(
          'market_candles',
          {
            instrumentKey: volumeKey,
            interval: 5,
            start: { $gte: session.open },
            end: { $lte: now },
            mode: { $in: modes },
          },
          { sort: { start: 1 } },
        );
        const profiles = await this.store.find(
          'market_volume_profiles',
          { instrumentKey: volumeKey, day: { $lt: day }, mode: { $in: modes } },
          { sort: { day: -1 }, limit: 25000 },
        );
        const volume = volumeIntelligence(
          volumeBars.find((c) => c.start === latest.start) ?? null,
          volumeBars.find((c) => c.start === session.open) ?? null,
          volumeBars,
          profiles,
          now,
          this.config,
        );
        run.volume.push(volume);
        const technical = technicalFeatures(bars, now),
          news = await this.news.context(key, now),
          regime = marketRegime(technical, uq.ltp, news.highImpact, this.config.MAX_ATR_PCT);
        await this.store.put('market_regimes', {
          id: `${key}:${now}`,
          instrumentKey: key,
          asOf: now,
          regime,
          technical,
          mode: this.config.DATA_MODE,
        });
        const minuteVolume = await this.store.find(
          'market_candles',
          { instrumentKey: volumeKey, interval: 1, end: { $lte: now }, receivedAt: { $lte: now } },
          { sort: { start: -1 }, limit: 700 },
        );
        const advanced = advancedVolume(
          minuteVolume,
          profiles,
          now,
          this.config,
          volumeBars.find((c) => c.start === session.open) ?? null,
        );
        await this.store.put('market_features', {
          id: key,
          instrumentKey: key,
          asOf: now,
          mode: this.config.DATA_MODE,
          advanced,
        });
        const futureQuotes =
          this.market.instruments.get(volumeKey)?.kind === 'FUT'
            ? await this.store.find(
                'option_snapshots',
                { instrumentKey: volumeKey, sourceTs: { $lte: now }, receivedAt: { $lte: now } },
                { sort: { sourceTs: -1 }, limit: 2 },
              )
            : [];
        const optionQuotes = [...this.market.quotes.values()].filter(
          (q) =>
            this.market.instruments.get(q.instrumentKey)?.underlyingKey === key &&
            ['CE', 'PE'].includes(this.market.instruments.get(q.instrumentKey)?.kind ?? ''),
        );
        const decisions = this.registry.assess({
          asOf: now,
          opening,
          latest,
          technical,
          volume,
          regime,
          bars,
          advanced,
          news: news.items,
          futureQuotes,
          optionQuotes,
          maxAtrPct: this.config.MAX_ATR_PCT,
          maxSpreadPct: this.config.MAX_SPREAD_PCT,
        });
        await this.store.insertMany('strategy_decisions', [
          { id: `${id}:${key}`, runId: id, instrumentKey: key, asOf: now, regime, decisions },
        ]);
        const decision = decisions.find((d) => d.direction !== null);
        const gate = new VolumeCandidateFilter(this.config).evaluate(volume, !!decision);
        if (!decision || gate.length) {
          run.rejections.push({
            instrumentKey: key,
            reasons: [
              ...gate,
              ...decisions.flatMap((d) => d.conflicts),
              ...(decisions.length ? [] : [`REGIME_${regime}`]),
            ],
          });
          continue;
        }
        const eligible = [...this.market.instruments.values()].filter(
          (c) =>
            c.underlyingKey === key &&
            c.kind === (decision.direction === 'BULLISH' ? 'CE' : 'PE') &&
            c.active,
        );
        let count = 0;
        for (const contract of eligible) {
          const q = this.market.quotes.get(contract.id);
          if (!q) continue;
          const scenario = buildScenario(contract, q, decision, this.config);
          if (!scenario) {
            run.rejections.push({
              instrumentKey: contract.id,
              reasons: ['GREEKS_OR_STRUCTURE_PREMIUM_PROJECTION_UNAVAILABLE'],
            });
            continue;
          }
          const candidate: Opportunity = {
            designation: 'INTRADAY',
            advanced,
            newsFeatures: {
              asOf: now,
              officialCount: news.items.length ? news.items.filter((n) => n.official).length : null,
              sentiment: news.items.some((n) => n.sentiment !== null)
                ? news.items.reduce(
                    (sum, n) => sum + (n.sentiment === 'positive' ? 1 : n.sentiment === 'negative' ? -1 : 0),
                    0,
                  )
                : null,
            },
            id: randomUUID(),
            day,
            slot: 1,
            analysisRunId: id,
            createdAt: now,
            expiresAt: Math.min(now + 15 * MINUTE, session.close),
            mode: this.config.DATA_MODE,
            underlying,
            contract,
            underlyingPrice: uq.ltp,
            quote: structuredClone(q),
            scenario,
            volume,
            technical,
            regime,
            strategy: decision,
            ranking: {
              rvol: volume.volumeSpikeRatio ?? 0,
              rewardRisk: scenario.rewardRisk,
              spreadPct: spread(q).percentage ?? Infinity,
              rankMethod:
                'lexicographic: eligible same-time RVOL, net reward/risk, spread; no probability interpretation',
            },
            probability: null,
            newsIds: news.items.map((n) => n.id),
            reasons: decision.reasons,
            warnings: [
              ...run.qualityLimitations,
              ...(news.conflicting ? ['CONFLICTING_NEWS_SENTIMENT'] : []),
              ...(contract.underlyingType === 'EQUITY'
                ? ['Stock option physical-settlement risk near expiry']
                : []),
            ],
            riskStatus: 'ACCEPTED',
            snapshotHash: '',
          };
          candidates.push(candidate);
          count++;
        }
        if (!count)
          run.rejections.push({ instrumentKey: key, reasons: ['NO_EXECUTABLE_LISTED_OPTION_SCENARIO'] });
      }
    if (requiredQuotes.length) {
      const times = requiredQuotes.map((q) => q.sourceTs);
      run.dataFreshness = {
        newestQuoteAt: Math.max(...times),
        oldestRequiredQuoteAt: Math.min(...times),
        maxAgeMs: this.config.QUOTE_MAX_AGE_MS,
        status:
          this.config.DATA_MODE === 'demo'
            ? 'DEMO'
            : times.every((t) => now - t <= this.config.QUOTE_MAX_AGE_MS)
              ? 'LIVE'
              : 'DELAYED',
      };
    }
    const ranked = rankCandidates(candidates);
    return this.store.transaction(async (store) => {
      const existing = await store.get('analysis_runs', id);
      if (existing) return existing;
      const settings = (await store.get('risk_settings', 'owner'))!,
        account = (await store.get('private_accounts', 'owner'))!;
      const saved = await store.find('trade_signals', { day });
      const selected = new Set(saved.map((s) => s.underlying.id));
      const exposure = await riskExposure(store, this.market, now);
      for (const candidate of ranked) {
        if (selected.has(candidate.underlying.id)) continue;
        const context = await this.news.context(candidate.underlying.id, now);
        const reasons = riskRejections(
          candidate.contract,
          candidate.quote,
          candidate.scenario,
          {
            now,
            settings,
            ...exposure,
            availableCash: account.cash - exposure.reservedCapital,
            dailyCount: saved.length,
            highImpactEvent: context.highImpact,
            eventCalendarReady: this.news.isCalendarReady(now),
          },
          this.config,
        );
        if (reasons.length) {
          run.rejections.push({ instrumentKey: candidate.contract.id, reasons });
          continue;
        }
        candidate.slot = saved.length + 1;
        candidate.snapshotHash = snapshotHash(candidate);
        await store.insert('trade_signals', candidate);
        await store.insert('signal_events', {
          id: `${candidate.id}:initial`,
          signalId: candidate.id,
          timestamp: now,
          status: 'WATCHING',
          reason: 'Research scenario published; no paper position opened',
          quoteId: candidate.quote.id,
        });
        saved.push(candidate);
        this.quality?.register(candidate);
        this.market.watchedKeys.add(candidate.contract.id);
        this.market.watchedKeys.add(candidate.underlying.id);
        selected.add(candidate.underlying.id);
        exposure.aggregateRisk += candidate.scenario.plannedLoss;
        exposure.correlatedRisk += candidate.scenario.plannedLoss;
        exposure.reservedCapital += candidate.scenario.oneLotCapital;
      }
      run.signalIds = saved.map((s) => s.id);
      run.signalStatuses = await Promise.all(
        saved.map(async (signal) => ({
          id: signal.id,
          status:
            signal.expiresAt <= now
              ? ('EXPIRED' as const)
              : ((await latestEvent(store, signal.id))?.status ?? 'WATCHING'),
          riskStatus: signal.riskStatus,
        })),
      );
      run.activeSignalIds = run.signalStatuses
        .filter((e) => !terminalStatuses.has(e.status) && e.status !== 'DATA_UNAVAILABLE')
        .map((e) => e.id);
      run.status = run.activeSignalIds.length
        ? 'OPPORTUNITIES'
        : run.volume.length && run.volume.some((v) => v.volumeConfirmationStatus !== 'INSUFFICIENT_DATA')
          ? 'NO_TRADE'
          : 'INSUFFICIENT_DATA';
      await store.insert('analysis_runs', run);
      return run;
    });
  }
  async monitor(q: Quote, now: number) {
    const signals = await this.store.find('trade_signals', { day: dayKey(now) });
    for (const s of signals) {
      if (q.instrumentKey !== s.contract.id && q.instrumentKey !== s.underlying.id) continue;
      const latest = await latestEvent(this.store, s.id);
      if (terminalStatuses.has(latest?.status ?? '')) continue;
      let status: SignalEvent['status'] | null = null,
        reason = '';
      if (now >= s.expiresAt) {
        status = 'EXPIRED';
        reason = 'Research validity window ended';
      } else if (!fresh(q.sourceTs, q.receivedAt, now, this.config.QUOTE_MAX_AGE_MS)) {
        status = 'DATA_UNAVAILABLE';
        reason = 'Fresh market quote unavailable';
      } else if (q.sourceTs < s.createdAt) continue;
      else if (
        q.instrumentKey === s.underlying.id &&
        ((s.strategy.direction === 'BULLISH' && q.ltp <= s.scenario.underlyingInvalidation) ||
          (s.strategy.direction === 'BEARISH' && q.ltp >= s.scenario.underlyingInvalidation))
      ) {
        status = 'INVALIDATED';
        reason = 'Underlying structure invalidated';
      } else if (q.instrumentKey === s.contract.id) {
        const events = await this.store.find('signal_events', { signalId: s.id });
        const triggered = events.some((e) => ['TRIGGERED', 'TARGET_1_HIT'].includes(e.status));
        if (triggered && q.bid !== null) {
          if (q.bid <= s.scenario.stop) {
            status = 'STOPPED';
            reason = 'Observed bid crossed research stop';
          } else if (q.bid >= s.scenario.target2) {
            status = 'TARGET_2_HIT';
            reason = 'Observed bid reached research second target';
          } else if (q.bid >= s.scenario.target1 && latest?.status !== 'TARGET_1_HIT') {
            status = 'TARGET_1_HIT';
            reason = 'Observed bid reached research first target';
          }
        } else if (q.ask !== null && q.ask >= s.scenario.entryLow && q.ask <= s.scenario.entryHigh) {
          status = 'TRIGGERED';
          reason = 'Observed ask entered research range; this is not a paper fill';
        }
      }
      if (status && status !== latest?.status)
        try {
          await this.store.insert('signal_events', {
            id: `${s.id}:${status}:${q.sourceTs}`,
            signalId: s.id,
            timestamp: now,
            status,
            reason,
            quoteId: q.id,
          });
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
        }
    }
  }
  async expire(now: number) {
    for (const s of await this.store.find('trade_signals', { day: dayKey(now), expiresAt: { $lte: now } })) {
      if (terminalStatuses.has((await latestEvent(this.store, s.id))?.status ?? '')) continue;
      try {
        await this.store.insert('signal_events', {
          id: `${s.id}:expiry`,
          signalId: s.id,
          timestamp: now,
          status: 'EXPIRED',
          reason: 'Research validity window ended',
          quoteId: null,
        });
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
    }
  }
  async latest(initial = false) {
    const runs = await this.store.find('analysis_runs', initial ? { kind: 'INITIAL' } : {}, {
      sort: { analyzedAt: -1 },
      limit: 1,
    });
    return runs[0] ?? null;
  }
  async volumes(key: string): Promise<VolumeFeatures | null> {
    const run = await this.latest();
    return run?.volume.find((v) => v.volumeInstrumentKey === key) ?? null;
  }
}
