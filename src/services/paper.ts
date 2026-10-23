import { randomUUID } from 'node:crypto';
import type { Store } from '../db/store.js';
import type { Config } from '../config.js';
import type { PaperTrade, Quote, Scenario } from '../domain.js';
import type { MarketService } from './market.js';
import type { NewsService } from './news.js';
import { charges, roundTick, riskRejections } from '../engines/risk.js';
import { correlationGroup, latestEvent, riskExposure, terminalStatuses } from './analysis.js';
import { dayKey, fresh } from '../market/time.js';
import { performance } from '../engines/backtest.js';
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly reasons: string[] = [],
    readonly status = 409,
  ) {
    super(code);
  }
}
export class PaperService {
  constructor(
    private store: Store,
    private market: MarketService,
    private news: NewsService,
    private config: Config,
  ) {}
  async open(signalId: string, lots: number, requestKey: string, now: number) {
    return this.store.transaction(async (store) => {
      const existing = (await store.find('paper_trades', { requestKey }, { limit: 1 }))[0];
      if (existing) {
        if (existing.signalId !== signalId || existing.lots !== lots)
          throw new DomainError('IDEMPOTENCY_KEY_REUSED');
        return existing;
      }
      const signal = await store.get('trade_signals', signalId);
      if (!signal) throw new DomainError('SIGNAL_NOT_FOUND', [], 404);
      if (
        signal.expiresAt <= now ||
        signal.createdAt > now ||
        terminalStatuses.has((await latestEvent(store, signalId))?.status ?? '')
      )
        throw new DomainError('SIGNAL_NOT_ACTIVE');
      if (!Number.isInteger(lots) || lots < 1 || lots > 100) throw new DomainError('INVALID_LOTS', [], 400);
      if (
        (await store.find('paper_trades', { underlyingKey: signal.underlying.id, day: dayKey(now) })).length
      )
        throw new DomainError('NO_AVERAGING_OR_REPEATED_ENTRY');
      const q = this.market.quotes.get(signal.contract.id),
        session = this.market.session;
      if (!q || q.ask === null || q.bid === null) throw new DomainError('NO_FILL', ['NO_EXECUTABLE_QUOTE']);
      if (!session || !session.trading || now < session.open || now >= session.close)
        throw new DomainError('NO_FILL', ['OUTSIDE_SESSION']);
      const quantity = lots * signal.contract.lotSize;
      if (q.askQty < quantity || q.bidQty < quantity)
        throw new DomainError('NO_FILL', ['INSUFFICIENT_DEPTH']);
      const entry = roundTick(q.ask * (1 + this.config.SLIPPAGE_BPS / 10000), signal.contract.tickSize, 'up');
      if (entry > signal.scenario.entryHigh || entry < signal.scenario.entryLow)
        throw new DomainError('NO_FILL', ['ENTRY_RANGE_NOT_EXECUTABLE']);
      const entryFee = charges(entry, quantity, 'BUY', this.config),
        exitFee = charges(signal.scenario.stop, quantity, 'SELL', this.config),
        plannedRisk =
          (entry - signal.scenario.stop) * quantity +
          entryFee +
          exitFee +
          (signal.scenario.stop * quantity * this.config.SLIPPAGE_BPS) / 10000;
      const scenario: Scenario = {
        ...signal.scenario,
        quantity,
        entryHigh: entry,
        oneLotCapital: entry * quantity + entryFee,
        plannedLoss: plannedRisk,
        estimatedCosts: entryFee + exitFee,
        rewardRisk:
          ((signal.scenario.target1 - entry) * quantity -
            entryFee -
            charges(signal.scenario.target1, quantity, 'SELL', this.config)) /
          plannedRisk,
      };
      const account = (await store.get('private_accounts', 'owner'))!,
        settings = (await store.get('risk_settings', 'owner'))!,
        exposure = await riskExposure(store, this.market, now, signalId),
        news = await this.news.context(signal.underlying.id, now);
      const reasons = riskRejections(
        signal.contract,
        q,
        scenario,
        {
          now,
          settings,
          ...exposure,
          availableCash: account.cash - exposure.reservedCapital,
          dailyCount: 0,
          highImpactEvent: news.highImpact,
          eventCalendarReady: this.news.isCalendarReady(now),
        },
        this.config,
      );
      if (reasons.length) throw new DomainError('RISK_REJECTED', reasons);
      const trade: PaperTrade = {
        id: randomUUID(),
        signalId,
        instrumentKey: signal.contract.id,
        underlyingKey: signal.underlying.id,
        correlationGroup: correlationGroup(signal.underlying),
        day: dayKey(now),
        openedAt: now,
        quantity,
        lots,
        entry,
        entryFee,
        stop: signal.scenario.stop,
        target1: signal.scenario.target1,
        target2: signal.scenario.target2,
        plannedRisk,
        status: 'OPEN',
        exit: null,
        exitFee: null,
        closedAt: null,
        pnl: null,
        closeReason: null,
        mode: signal.mode,
        requestKey,
      };
      await store.insert('paper_trades', trade);
      this.market.watchedKeys.add(trade.instrumentKey);
      await store.insert('paper_trade_executions', {
        id: `${trade.id}:BUY`,
        tradeId: trade.id,
        timestamp: now,
        side: 'BUY',
        price: entry,
        quantity,
        fee: entryFee,
        quoteId: q.id,
        method: 'ask plus configured slippage; whole-quantity best-level depth required',
      });
      await store.put('private_accounts', {
        ...account,
        cash: account.cash - entry * quantity - entryFee,
        updatedAt: now,
      });
      return trade;
    });
  }
  async close(tradeId: string, now: number, reason = 'MANUAL'): Promise<PaperTrade> {
    return this.store.transaction(async (store) => {
      const trade = await store.get('paper_trades', tradeId);
      if (!trade) throw new DomainError('TRADE_NOT_FOUND', [], 404);
      if (trade.status === 'CLOSED') return trade;
      const q = this.market.quotes.get(trade.instrumentKey),
        instrument = this.market.instruments.get(trade.instrumentKey);
      if (
        !q ||
        q.bid === null ||
        q.bidQty < trade.quantity ||
        !instrument ||
        !fresh(q.sourceTs, q.receivedAt, now, this.config.QUOTE_MAX_AGE_MS) ||
        !fresh(q.lastTradeTs, q.receivedAt, now, this.config.QUOTE_MAX_AGE_MS) ||
        q.sourceTs < trade.openedAt
      )
        throw new DomainError('NO_FILL', ['FRESH_EXECUTABLE_EXIT_UNAVAILABLE']);
      const exit = Math.max(
          instrument.tickSize,
          roundTick(q.bid * (1 - this.config.SLIPPAGE_BPS / 10000), instrument.tickSize, 'down'),
        ),
        exitFee = charges(exit, trade.quantity, 'SELL', this.config),
        pnl = (exit - trade.entry) * trade.quantity - trade.entryFee - exitFee;
      const updated: PaperTrade = {
        ...trade,
        status: 'CLOSED',
        exit,
        exitFee,
        pnl,
        closedAt: now,
        closeReason: reason,
      };
      const account = (await store.get('private_accounts', 'owner'))!;
      await store.put('paper_trades', updated);
      await store.insert('paper_trade_executions', {
        id: `${trade.id}:SELL`,
        tradeId: trade.id,
        timestamp: now,
        side: 'SELL',
        price: exit,
        quantity: trade.quantity,
        fee: exitFee,
        quoteId: q.id,
        method: 'observed bid minus slippage; gaps can exceed planned loss',
      });
      await store.put('private_accounts', {
        ...account,
        cash: account.cash + exit * trade.quantity - exitFee,
        realizedPnl: account.realizedPnl + pnl,
        updatedAt: now,
      });
      return updated;
    });
  }
  async monitor(q: Quote, now: number) {
    for (const t of await this.store.find('paper_trades', {
      instrumentKey: q.instrumentKey,
      status: 'OPEN',
    })) {
      if (q.bid === null || q.sourceTs < t.openedAt) continue;
      const reason =
        q.bid <= t.stop
          ? 'STOP'
          : q.bid >= t.target2
            ? 'TARGET_2'
            : this.market.session && now >= this.market.session.close - 60000
              ? 'SESSION_CLOSE'
              : null;
      if (reason)
        try {
          await this.close(t.id, now, reason);
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
        }
    }
  }
  async finalize(now: number) {
    const unclosed: string[] = [];
    for (const t of await this.store.find('paper_trades', { status: 'OPEN' })) {
      try {
        await this.close(t.id, now, 'SESSION_CLOSE');
      } catch (e) {
        if (!(e instanceof DomainError)) throw e;
        unclosed.push(t.id);
      }
    }
    return unclosed;
  }
  async report(now: number) {
    const trades = await this.store.find('paper_trades', {}, { sort: { openedAt: 1 } });
    const open = trades
      .filter((t) => t.status === 'OPEN')
      .map((t) => {
        const q = this.market.quotes.get(t.instrumentKey),
          valid = q && q.bid !== null && fresh(q.sourceTs, q.receivedAt, now, this.config.QUOTE_MAX_AGE_MS);
        return {
          ...t,
          unrealizedPnl: valid
            ? (q.bid! - t.entry) * t.quantity - t.entryFee - charges(q.bid!, t.quantity, 'SELL', this.config)
            : null,
          markStatus: valid ? 'FRESH' : 'UNAVAILABLE',
        };
      });
    const closed = trades.filter((t) => t.status === 'CLOSED').sort((a, b) => a.closedAt! - b.closedAt!);
    const dailyClosed = closed.filter((t) => t.closedAt !== null && dayKey(t.closedAt) === dayKey(now));
    return {
      account: await this.store.get('private_accounts', 'owner'),
      metrics: performance(closed.map((t) => t.pnl!)),
      daily: {
        day: dayKey(now),
        timezone: 'Asia/Kolkata',
        ...performance(dailyClosed.map((t) => t.pnl!)),
        wins: dailyClosed.filter((t) => t.pnl! > 0).length,
        losses: dailyClosed.filter((t) => t.pnl! < 0).length,
        breakeven: dailyClosed.filter((t) => t.pnl === 0).length,
        fees: dailyClosed.reduce((sum, t) => sum + t.entryFee + (t.exitFee ?? 0), 0),
        grossPnl: dailyClosed.reduce((sum, t) => sum + (t.exit! - t.entry) * t.quantity, 0),
        costsVerified: this.config.COSTS_VERIFIED,
        methodology:
          'Completed paper trades by IST exit date; net P&L includes simulated fees and execution slippage; raw signals excluded',
      },
      open,
      closed,
      validation: {
        forwardSessions: new Set(trades.filter((t) => t.mode === 'live').map((t) => t.day)).size,
        recommendedMinimumSessions: 30,
        statisticallyValidated: false,
        limitation: 'Passing software tests and paper outcomes do not demonstrate predictive accuracy',
      },
    };
  }
}
