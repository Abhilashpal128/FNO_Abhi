import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { MongoStore } from '../src/db/store.js';
import { retentionPolicy } from '../src/db/retention.js';
const config = loadConfig(),
  path = process.argv[2];
if (!path) throw new Error('Usage: export-training <new-output.jsonl>');
const store = await MongoStore.connect(
  config.MONGODB_URI,
  config.SNAPSHOT_RETENTION_DAYS,
  retentionPolicy(config),
);
const file = await open(resolve(path), 'wx', 0o600);
let exported = 0;
try {
  const outcomes = await store.find(
    'research_outcomes',
    { status: { $in: ['TARGET_BEFORE_STOP', 'STOP_BEFORE_TARGET', 'NEITHER_HIT'] } },
    { sort: { candidateAt: 1 }, limit: 100000 },
  );
  for (const outcome of outcomes) {
    const s = await store.get('trade_signals', outcome.signalId);
    if (!s) continue;
    const trade = (await store.find('paper_trades', { signalId: s.id, status: 'CLOSED' }, { limit: 1 }))[0];
    const row = {
      id: s.id,
      signalAt: s.createdAt,
      horizonEnd: outcome.horizonEnd,
      availableAt: Math.max(outcome.horizonEnd, outcome.evaluatedAt),
      featuresAsOf: s.createdAt,
      outcomeDefinition: 'option-target2-before-stop-v1',
      label: outcome.status === 'TARGET_BEFORE_STOP' ? 1 : 0,
      regime: s.regime,
      grossPnl: trade ? ((trade.exit ?? trade.entry) - trade.entry) * trade.quantity : null,
      fees: trade ? trade.entryFee + (trade.exitFee ?? 0) : null,
      slippage: trade ? 0 : null,
      costMethod: 'Paper execution prices include slippage; zero additional deduction avoids double counting',
      features: {
        volume_rvol: s.volume.volumeSpikeRatio,
        volume_openingRvol: s.volume.openingFiveMinuteRvol,
        volume_acceleration: s.advanced?.volumeAcceleration ?? null,
        volume_zScore: s.advanced?.volumeZScore ?? null,
        volume_vwapDeviationPct: s.advanced?.vwapDeviationPct ?? null,
        volume_obv: s.advanced?.obv ?? null,
        price_ema: s.technical.ema,
        price_rsi: s.technical.rsi,
        price_atr: s.technical.atr,
        price_momentum: s.technical.momentum,
        option_spreadPct: s.ranking.spreadPct,
        option_moneyness: s.contract.strike ? s.underlyingPrice / s.contract.strike - 1 : null,
        option_iv: s.quote.iv,
        option_delta: s.quote.delta,
        option_gamma: s.quote.gamma,
        option_theta: s.quote.theta,
        volume_optionVolume: s.quote.cumulativeVolume,
        volume_optionOi: s.quote.oi,
        news_officialCount: s.newsFeatures?.officialCount ?? null,
        news_sentiment: s.newsFeatures?.sentiment ?? null,
      },
    };
    await file.write(`${JSON.stringify(row)}\n`);
    exported++;
  }
  process.stdout.write(
    `Exported ${exported} timestamp-valid option outcome samples. No model trained or promoted.\n`,
  );
} finally {
  await file.close();
  await store.close();
}
