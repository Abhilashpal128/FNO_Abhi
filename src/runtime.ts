import { loadConfig, type Config } from './config.js';
import { createLogger } from './logger.js';
import { MongoStore, MemoryStore } from './db/store.js';
import { retentionPolicy } from './db/retention.js';
import { UpstoxProvider } from './providers/upstox.js';
import { MarketService } from './services/market.js';
import { NewsService } from './services/news.js';
import { AnalysisService } from './services/analysis.js';
import { PaperService } from './services/paper.js';
import { ResearchQualityService } from './services/quality.js';
import { StorageHealthService } from './services/storage.js';
import { seedDemo, DEMO_NOW } from './testing/demo.js';

/** Construct services without listeners, sockets, timers or background work. */
export async function createRuntime(config: Config = loadConfig()) {
  const log = createLogger(config.LOG_LEVEL);
  const store = config.STORAGE_MODE === 'mongo'
    ? await MongoStore.connect(config.MONGODB_URI, config.SNAPSHOT_RETENTION_DAYS, retentionPolicy(config))
    : new MemoryStore(retentionPolicy(config));
  try {
    const provider = config.DATA_MODE === 'live' ? new UpstoxProvider(config) : null;
    const now = config.DATA_MODE === 'demo' ? () => DEMO_NOW : () => Date.now();
    const market = new MarketService(store, config, provider, log);
    const news = new NewsService(store, config, provider);
    const analysis = new AnalysisService(store, market, news, config);
    const paper = new PaperService(store, market, news, config);
    const quality = new ResearchQualityService(store, config);
    const storage = new StorageHealthService(store, market, config);
    await analysis.initialize(now());
    analysis.quality = quality;
    await market.load();
    if (config.DATA_MODE === 'demo') {
      await seedDemo(store, market);
      await analysis.evaluate('INITIAL', DEMO_NOW - 2000, DEMO_NOW, 'demo-initial');
      log.warn('DEMO: synthetic instruments and frozen analysis clock; ephemeral data if STORAGE_MODE=memory');
    }
    return { store, config, log, provider, now, market, news, analysis, paper, quality, storage };
  } catch (error) {
    await store.close();
    throw error;
  }
}
