import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { MongoStore, MemoryStore } from './db/store.js';
import { UpstoxProvider } from './providers/upstox.js';
import { MarketService } from './services/market.js';
import { NewsService } from './services/news.js';
import { AnalysisService } from './services/analysis.js';
import { PaperService } from './services/paper.js';
import { MarketScheduler } from './services/scheduler.js';
import { createApp } from './api/app.js';
import { seedDemo, DEMO_NOW } from './testing/demo.js';
import { retentionPolicy } from './db/retention.js';
import { StorageHealthService } from './services/storage.js';
import { ResearchQualityService } from './services/quality.js';
export async function startServer() {
  const config = loadConfig(),
    log = createLogger(config.LOG_LEVEL);
  const store =
    config.STORAGE_MODE === 'mongo'
      ? await MongoStore.connect(config.MONGODB_URI, config.SNAPSHOT_RETENTION_DAYS, retentionPolicy(config))
      : new MemoryStore(retentionPolicy(config));
  const provider = config.DATA_MODE === 'live' ? new UpstoxProvider(config) : null,
    now = config.DATA_MODE === 'demo' ? () => DEMO_NOW : () => Date.now();
  const market = new MarketService(store, config, provider, log),
    news = new NewsService(store, config, provider),
    analysis = new AnalysisService(store, market, news, config),
    paper = new PaperService(store, market, news, config);
  await analysis.initialize(now());
  const quality = new ResearchQualityService(store, config);
  analysis.quality = quality;
  await market.load();
  news.start(() =>
    market.underlyings.length ? market.underlyings.map((i) => i.id) : config.UPSTOX_UNDERLYING_KEYS,
  );
  if (config.DATA_MODE === 'demo') {
    await seedDemo(store, market);
    await analysis.evaluate('INITIAL', DEMO_NOW - 2000, DEMO_NOW, 'demo-initial');
    log.warn('DEMO: synthetic instruments and frozen analysis clock; ephemeral data if STORAGE_MODE=memory');
  }
  market.onQuote(async (q) => {
    quality.observe(q);
    await analysis.monitor(q, now());
    await paper.monitor(q, now());
  });
  const scheduler = new MarketScheduler(store, market, news, analysis, paper, config, log),
    storage = new StorageHealthService(store, market, config),
    app = createApp({ store, market, analysis, paper, config, log, now, storage, quality });
  let qualityJob: Promise<void> | null = null;
  const qualityTimer = setInterval(() => {
    if (qualityJob) return;
    qualityJob = quality
      .refresh(now())
      .catch(() => log.error('Research outcome evaluation unavailable'))
      .finally(() => {
        qualityJob = null;
      });
  }, 10000);
  let storageJob: Promise<void> | null = null;
  const checkStorage = () => {
    if (storageJob) return;
    storageJob = storage
      .check(now())
      .then(() => {})
      .catch(() => log.error('Storage health unavailable'))
      .finally(() => {
        storageJob = null;
      });
  };
  const storageTimer = setInterval(checkStorage, config.STORAGE_CHECK_INTERVAL_MS);
  checkStorage();
  const server = app.listen(config.PORT, config.HOST, () => {
    log.info(
      { host: config.HOST, port: config.PORT, mode: config.DATA_MODE, persistent: store.persistent },
      'Research backend listening',
    );
    scheduler.start();
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(storageTimer);
    clearInterval(qualityTimer);
    log.info('Shutting down');
    const deadline = setTimeout(() => {
      log.error('Shutdown deadline exceeded');
      process.exit(1);
    }, 25000);
    deadline.unref();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await scheduler.stop();
    await market.stop();
    await news.stop();
    await Promise.all([qualityJob, storageJob]);
    await store.close();
    clearTimeout(deadline);
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void shutdown()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
  server.on('error', (error) => {
    log.error({ errorType: error.name }, 'Listener failed');
    void shutdown().then(() => process.exit(1));
  });
  return { server, shutdown, app };
}
startServer().catch((error) => {
  process.stderr.write(
    `${error instanceof Error && error.message.startsWith('Invalid environment:') ? error.message : 'Startup failed. Check MongoDB replica set, environment configuration and server availability.'}\n`,
  );
  process.exitCode = 1;
});
