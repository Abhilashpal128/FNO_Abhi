import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { DEMO_NOW, DEMO_DAY } from '../src/testing/demo.js';
import { atIST, dayKey, sessionSchedule, demoSession } from '../src/market/time.js';
import { JobCoordinator } from '../src/services/scheduler.js';
import { snapshotHash, rankCandidates, latestEvent } from '../src/services/analysis.js';
import { asOfCandles, conservativeCandleExit, performance, runBacktest } from '../src/engines/backtest.js';
import { eligibleNews } from '../src/services/news.js';
import { ValidatedModelService } from '../src/services/models.js';
import type { Opportunity, Candle, NewsItem } from '../src/domain.js';

describe('analysis pipeline', () => {
  it('publishes a fully explained demo scenario with null probability and correct lot size', async () => {
    const s = await fixture();
    const run = await s.analysis.evaluate('INITIAL', DEMO_NOW - 2000, DEMO_NOW);
    expect(run.status).toBe('OPPORTUNITIES');
    expect(run.signalIds).toHaveLength(1);
    const signal = (await s.store.get('trade_signals', run.signalIds[0]!))!;
    expect(signal.contract.id).toBe('DEMO|ACME_CE');
    expect(signal.probability).toBeNull();
    expect(signal.volume.openingFiveMinuteRvol).toBe(3);
    expect(signal.scenario.quantity).toBe(100);
    expect(signal.scenario.rewardRisk).toBeGreaterThan(1.5);
    expect(signal.snapshotHash).toBe(snapshotHash(signal));
    expect(await s.store.find('paper_trades')).toHaveLength(0);
  });
  it('publishes insufficient data before the opening window has actually completed', async () => {
    const s = await fixture();
    const run = await s.analysis.evaluate('INITIAL', DEMO_NOW - 2000, DEMO_NOW - 2001);
    expect(run.status).toBe('INSUFFICIENT_DATA');
    expect(run.signalIds).toHaveLength(0);
  });
  it('does not duplicate daily signals under concurrent refresh requests', async () => {
    const s = await fixture();
    await Promise.all(Array.from({ length: 10 }, () => s.analysis.evaluate('MANUAL', DEMO_NOW, DEMO_NOW)));
    expect(await s.store.find('trade_signals')).toHaveLength(1);
  });
  it('records NO TRADE reasons when kill switch is enabled', async () => {
    const s = await fixture(),
      settings = (await s.store.get('risk_settings', 'owner'))!;
    await s.store.put('risk_settings', { ...settings, globalNoTrade: true });
    const run = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW);
    expect(run.status).toBe('NO_TRADE');
    expect(run.rejections.flatMap((r) => r.reasons)).toContain('GLOBAL_NO_TRADE');
  });
  it('returns insufficient data rather than fabricating option prices on a feed outage', async () => {
    const s = await fixture();
    s.market.quotes.clear();
    const run = await s.analysis.evaluate('MANUAL', DEMO_NOW, DEMO_NOW);
    expect(run.status).toBe('INSUFFICIENT_DATA');
    expect(run.signalIds).toEqual([]);
  });
  it('keeps original snapshot unchanged when lifecycle expires', async () => {
    const s = await fixture();
    const r = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW);
    const original = (await s.store.get('trade_signals', r.signalIds[0]!))!;
    await s.analysis.expire(DEMO_NOW + 16 * 60000);
    expect((await latestEvent(s.store, original.id))?.status).toBe('EXPIRED');
    expect(await s.store.get('trade_signals', original.id)).toEqual(original);
  });
  it('ranks eligible candidates by RVOL before reward/risk and spread', async () => {
    const s = await fixture(),
      r = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW),
      o = (await s.store.get('trade_signals', r.signalIds[0]!))!;
    const a = { ...o, id: 'a', ranking: { ...o.ranking, rvol: 3, rewardRisk: 2 } },
      b = { ...o, id: 'b', ranking: { ...o.ranking, rvol: 4, rewardRisk: 1.6 } };
    expect(rankCandidates([a, b]).map((c) => c.id)).toEqual(['b', 'a']);
  });
  it('caps the entire day at five unique underlyings across concurrent analyses', async () => {
    const s = await fixture();
    s.config.MAX_CORRELATED_RISK = 100000;
    s.config.MAX_AGGREGATE_RISK = 100000;
    s.config.MAX_DAILY_LOSS = 100000;
    const settings = (await s.store.get('risk_settings', 'owner'))!;
    await s.store.put('risk_settings', {
      ...settings,
      maxCorrelatedRisk: 100000,
      maxAggregateRisk: 100000,
      maxDailyLoss: 100000,
    });
    const u = s.market.underlyings[0]!,
      option = s.market.instruments.get('DEMO|ACME_CE')!,
      bars = await s.store.find('market_candles'),
      profiles = await s.store.find('market_volume_profiles');
    for (let i = 1; i < 7; i++) {
      const underlying = { ...u, id: `DEMO|ACME${i}`, underlyingKey: `DEMO|ACME${i}` },
        contract = { ...option, id: `DEMO|ACME${i}_CE`, underlyingKey: underlying.id };
      s.market.underlyings.push(underlying);
      s.market.instruments.set(contract.id, contract);
      s.market.volumeKeys.set(underlying.id, underlying.id);
      for (const c of bars)
        await s.store.put('market_candles', { ...c, id: `${c.id}:${i}`, instrumentKey: underlying.id });
      for (const p of profiles)
        await s.store.put('market_volume_profiles', {
          ...p,
          id: `${p.id}:${i}`,
          instrumentKey: underlying.id,
        });
      s.market.quotes.set(underlying.id, {
        ...s.market.quotes.get(u.id)!,
        instrumentKey: underlying.id,
        id: `uq${i}`,
      });
      s.market.quotes.set(contract.id, {
        ...s.market.quotes.get(option.id)!,
        instrumentKey: contract.id,
        id: `oq${i}`,
      });
    }
    await Promise.all([
      s.analysis.evaluate('MANUAL', DEMO_NOW, DEMO_NOW),
      s.analysis.evaluate('MANUAL', DEMO_NOW, DEMO_NOW),
    ]);
    const signals = await s.store.find('trade_signals');
    expect(signals).toHaveLength(5);
    expect(new Set(signals.map((o) => o.slot)).size).toBe(5);
    expect(new Set(signals.map((o) => o.underlying.id)).size).toBe(5);
  });
});
describe('paper fills and account integrity', () => {
  async function ready() {
    const s = await fixture();
    const run = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW);
    return { ...s, signalId: run.signalIds[0]! };
  }
  it('fills one explicit request once under a race and realizes net P&L at executable bid', async () => {
    const s = await ready();
    const trades = await Promise.all([
      s.paper.open(s.signalId, 1, 'same-request-key', DEMO_NOW),
      s.paper.open(s.signalId, 1, 'same-request-key', DEMO_NOW),
    ]);
    expect(trades[0]?.id).toBe(trades[1]?.id);
    expect(await s.store.find('paper_trade_executions')).toHaveLength(1);
    const trade = trades[0]!;
    const q = s.market.quotes.get(trade.instrumentKey)!;
    s.market.quotes.set(q.instrumentKey, {
      ...q,
      id: 'exit-q',
      bid: trade.target2 + 1,
      ask: trade.target2 + 1.05,
      ltp: trade.target2 + 1,
      sourceTs: DEMO_NOW + 1000,
      lastTradeTs: DEMO_NOW + 1000,
      receivedAt: DEMO_NOW + 1000,
    });
    const closed = await s.paper.close(trade.id, DEMO_NOW + 1000);
    expect(closed.pnl).toBeGreaterThan(0);
    expect(closed.pnl).toBeCloseTo(
      (closed.exit! - closed.entry) * closed.quantity - closed.entryFee - closed.exitFee!,
    );
    expect((await s.store.get('private_accounts', 'owner'))?.cash).toBeCloseTo(
      s.config.SIMULATED_CAPITAL + closed.pnl!,
    );
    expect(await s.store.find('paper_trade_executions')).toHaveLength(2);
  });
  it('does not average down or reopen a research candidate', async () => {
    const s = await ready();
    await s.paper.open(s.signalId, 1, 'one-request-key', DEMO_NOW);
    await expect(s.paper.open(s.signalId, 1, 'different-request-key', DEMO_NOW)).rejects.toThrow(
      'NO_AVERAGING',
    );
  });
  it('does not assume execution with insufficient quantity or stale data', async () => {
    const s = await ready(),
      q = s.market.quotes.get('DEMO|ACME_CE')!;
    s.market.quotes.set(q.instrumentKey, { ...q, askQty: 10 });
    await expect(s.paper.open(s.signalId, 1, 'no-fill-request', DEMO_NOW)).rejects.toThrow('NO_FILL');
    expect(await s.store.find('paper_trades')).toHaveLength(0);
  });
  it('does not invent a closing fill on stale data', async () => {
    const s = await ready(),
      trade = await s.paper.open(s.signalId, 1, 'stale-exit-key', DEMO_NOW);
    await expect(s.paper.close(trade.id, DEMO_NOW + 60000)).rejects.toThrow('NO_FILL');
    expect((await s.store.get('paper_trades', trade.id))?.status).toBe('OPEN');
  });
  it('allows gap loss beyond the planned stop rather than filling at the stop price', async () => {
    const s = await ready(),
      trade = await s.paper.open(s.signalId, 1, 'gap-test-key', DEMO_NOW),
      q = s.market.quotes.get(trade.instrumentKey)!;
    const gap = {
      ...q,
      id: 'gap-q',
      bid: trade.stop - 5,
      ask: trade.stop - 4.95,
      ltp: trade.stop - 5,
      sourceTs: DEMO_NOW + 1000,
      receivedAt: DEMO_NOW + 1000,
      lastTradeTs: DEMO_NOW + 1000,
    };
    s.market.quotes.set(gap.instrumentKey, gap);
    await s.paper.monitor(gap, DEMO_NOW + 1000);
    const closed = (await s.store.get('paper_trades', trade.id))!;
    expect(closed.exit!).toBeLessThan(trade.stop - 4.9);
    expect(-closed.pnl!).toBeGreaterThan(trade.plannedRisk);
  });
});
describe('restart-safe jobs', () => {
  it('admits only one owner, recovers expired leases and prevents completed duplicates', async () => {
    const s = await fixture(),
      a = new JobCoordinator(s.store),
      b = new JobCoordinator(s.store),
      task = sessionSchedule(demoSession(DEMO_DAY))[2]!;
    const claims = await Promise.all([a.claim(task, DEMO_NOW), b.claim(task, DEMO_NOW)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims[0] ? a : b,
      loser = claims[0] ? b : a;
    expect(await loser.claim(task, DEMO_NOW + 1000)).toBeNull();
    expect(await loser.claim(task, DEMO_NOW + 61000)).not.toBeNull();
    await winner.finish(task.id, DEMO_NOW + 62000);
    expect((await s.store.get('data_ingestion_checkpoints', task.id))?.status).toBe('RUNNING');
    await loser.finish(task.id, DEMO_NOW + 62000);
    expect(await winner.claim(task, DEMO_NOW + 130000)).toBeNull();
  });
});
describe('historical reconstruction and model honesty', () => {
  it('reuses the strategy and simulates a next-quote entry and observed target exit', async () => {
    const s = await fixture(),
      run = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW),
      signal = (await s.store.get('trade_signals', run.signalIds[0]!))!;
    const original = signal.quote,
      entry = {
        ...original,
        id: 'replay-entry',
        sourceTs: DEMO_NOW + 1000,
        receivedAt: DEMO_NOW + 1000,
        lastTradeTs: DEMO_NOW + 1000,
      },
      exit = {
        ...original,
        id: 'replay-exit',
        bid: signal.scenario.target2 + 1,
        ask: signal.scenario.target2 + 1.05,
        ltp: signal.scenario.target2 + 1,
        sourceTs: DEMO_NOW + 10000,
        receivedAt: DEMO_NOW + 10000,
        lastTradeTs: DEMO_NOW + 10000,
      };
    const bars = await s.store.find('market_candles', { interval: 1 });
    const result = runBacktest(
      {
        id: 'positive-replay',
        createdAt: DEMO_NOW + 10000,
        underlying: signal.underlying,
        contract: signal.contract,
        underlyingCandles: bars,
        volumeCandles: bars,
        profiles: await s.store.find('market_volume_profiles'),
        quotes: [original, entry, exit],
        from: atIST(DEMO_DAY, '09:15'),
        to: DEMO_NOW + 10000,
        eventCalendarReady: true,
      },
      s.config,
    );
    expect(result.status).toBe('COMPLETE');
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.entryAt).toBe(entry.sourceTs);
    expect(result.trades[0]?.exitAt).toBe(exit.sourceTs);
    expect(result.metrics.netPnl).toBeGreaterThan(0);
    expect(result.baseline.trades).toBe(1);
  });
  it('excludes future-ended and later-received candles', () => {
    const base = {
      id: 'c',
      instrumentKey: 'D',
      interval: 1,
      start: 1,
      end: 5,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      oi: null,
      quality: [],
      complete: true,
      source: 'fixture',
      receivedAt: 5,
      mode: 'demo',
    } as Candle;
    expect(
      asOfCandles([base, { ...base, id: 'late', receivedAt: 11 }, { ...base, id: 'future', end: 12 }], 10),
    ).toEqual([base]);
  });
  it('treats simultaneous target/stop candle touches conservatively and explicitly', () => {
    const bar = { open: 10, high: 15, low: 5 } as Candle;
    expect(conservativeCandleExit(bar, 8, 12)).toEqual({
      price: 8,
      reason: 'AMBIGUOUS_BOTH_TOUCHED_STOP_FIRST',
    });
  });
  it('returns insufficient data for unrecorded expired-option history', async () => {
    const s = await fixture(),
      bars = await s.store.find('market_candles', { interval: 1 }),
      contract = s.market.instruments.get('DEMO|ACME_CE')!;
    const result = runBacktest(
      {
        id: 'test',
        createdAt: DEMO_NOW,
        underlying: s.market.underlyings[0]!,
        contract,
        underlyingCandles: bars,
        volumeCandles: bars,
        profiles: await s.store.find('market_volume_profiles'),
        quotes: [],
        from: atIST(DEMO_DAY, '09:15'),
        to: DEMO_NOW,
        eventCalendarReady: true,
      },
      s.config,
    );
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.metrics.trades).toBe(0);
    expect(result.metrics.winRate).toBeNull();
  });
  it('calculates net P&L, drawdown and profit factor from independently checkable outcomes', () => {
    expect(performance([100, -40, -80, 50])).toEqual({
      trades: 4,
      netPnl: 30,
      winRate: 0.5,
      expectancy: 7.5,
      maxDrawdown: 120,
      profitFactor: 1.25,
    });
  });
  it('excludes news published or received after the decision', () => {
    const n = { id: 'n', publishedAt: 1, receivedAt: 2 } as NewsItem;
    expect(
      eligibleNews(
        [n, { ...n, id: 'published-late', publishedAt: 11 }, { ...n, id: 'received-late', receivedAt: 11 }],
        10,
      ),
    ).toEqual([n]);
  });
  it('returns null if a calibrated model is unavailable', async () => {
    const s = await fixture();
    expect(
      (await new ValidatedModelService(s.store, '').predict('no-model', {}, DEMO_NOW)).probability,
    ).toBeNull();
  });
  it('hash is independent of object insertion order', async () => {
    const s = await fixture(),
      r = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW),
      signal = (await s.store.get('trade_signals', r.signalIds[0]!))!;
    const reordered = Object.fromEntries(Object.entries(signal).reverse()) as unknown as Opportunity;
    expect(snapshotHash(reordered)).toBe(signal.snapshotHash);
    expect(dayKey(DEMO_NOW)).toBe(DEMO_DAY);
  });
});
