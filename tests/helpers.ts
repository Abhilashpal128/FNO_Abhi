import { configSchema } from '../src/config.js';
import { MemoryStore, type Store } from '../src/db/store.js';
import { createLogger } from '../src/logger.js';
import { MarketService } from '../src/services/market.js';
import { NewsService } from '../src/services/news.js';
import { AnalysisService } from '../src/services/analysis.js';
import { PaperService } from '../src/services/paper.js';
import { seedDemo, DEMO_NOW } from '../src/testing/demo.js';
import { hashPassword } from '../src/api/auth.js';
export const TEST_PASSWORD = 'test-only-password-never-used-outside-tests';
export async function fixture(store: Store = new MemoryStore()) {
  const config = configSchema.parse({
      APP_PASSWORD_HASH: await hashPassword(TEST_PASSWORD),
      JWT_SECRET: 'fixture-signing-key-not-a-live-credential-'.repeat(2),
      DATA_MODE: 'demo',
      STORAGE_MODE: store.persistent ? 'mongo' : 'memory',
      LOG_LEVEL: 'silent',
      BASELINE_MIN_SAMPLES: 10,
      REQUIRE_EVENT_CALENDAR: 'false',
    }),
    log = createLogger('silent');
  const market = new MarketService(store, config, null, log),
    news = new NewsService(store, config, null),
    analysis = new AnalysisService(store, market, news, config),
    paper = new PaperService(store, market, news, config);
  await analysis.initialize(DEMO_NOW);
  await seedDemo(store, market);
  return { store, market, news, analysis, paper, config, log, now: () => DEMO_NOW };
}
