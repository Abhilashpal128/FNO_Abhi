import 'dotenv/config';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const positive = (v: number) => z.coerce.number().positive().finite().default(v);
const optionalUrl = z
  .union([
    z.literal(''),
    z
      .url()
      .refine(
        (v) =>
          ['http:', 'https:'].includes(new URL(v).protocol) && !new URL(v).username && !new URL(v).password,
        'Use an HTTP(S) URL without credentials',
      ),
  ])
  .default('');
const csv = z
  .string()
  .default('')
  .transform((v) =>
    v
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );
export const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: positive(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    DATA_MODE: z.enum(['demo', 'live']).default('demo'),
    STORAGE_MODE: z.enum(['memory', 'mongo']).default('memory'),
    MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/stockss?replicaSet=rs0'),
    APP_USERNAME: z.string().min(1).default('owner'),
    APP_PASSWORD_HASH: z.string().min(32),
    JWT_SECRET: z.string().min(48),
    TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
    CORS_ORIGINS: csv,
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
    UPSTOX_ANALYTICS_TOKEN: z.string().default(''),
    UPSTOX_UNDERLYING_KEYS: csv,
    MAX_UNDERLYINGS: z.coerce.number().int().min(1).max(100).default(12),
    MAX_SUBSCRIPTIONS: z.coerce.number().int().min(1).max(1500).default(500),
    UPSTOX_REQUESTS_PER_SECOND: z.coerce.number().int().min(1).max(10).default(5),
    QUOTE_MAX_AGE_MS: positive(15000),
    FEED_HEARTBEAT_MS: positive(30000),
    CANDLE_GRACE_MS: positive(2000),
    BASELINE_SESSIONS: z.coerce.number().int().min(2).max(60).default(20),
    BASELINE_MIN_SAMPLES: z.coerce.number().int().min(2).max(60).default(10),
    MIN_RVOL: positive(1.5),
    VOLUME_SPIKE_RATIO: positive(2),
    MIN_OPTION_VOLUME: positive(1000),
    MAX_SPREAD_PCT: positive(1.5),
    MIN_REWARD_RISK: positive(1.5),
    MAX_ATR_PCT: positive(3),
    SIMULATED_CAPITAL: positive(100000),
    MAX_RISK_PER_TRADE: positive(1000),
    MAX_DAILY_LOSS: positive(3000),
    MAX_AGGREGATE_RISK: positive(3000),
    MAX_CORRELATED_RISK: positive(1500),
    MAX_DAILY_OPPORTUNITIES: z.coerce.number().int().min(1).max(5).default(5),
    MIN_EXPIRY_DAYS: positive(1),
    STOCK_EXPIRY_BUFFER_DAYS: positive(4),
    GLOBAL_NO_TRADE: bool.default(false),
    COSTS_VERIFIED: bool.default(false),
    BROKERAGE_PER_ORDER: z.coerce.number().min(0).default(20),
    EXCHANGE_FEE_RATE: positive(0.0004),
    SEBI_FEE_RATE: positive(0.000001),
    GST_RATE: positive(0.18),
    STT_SELL_RATE: positive(0.0015),
    STAMP_BUY_RATE: positive(0.00003),
    SLIPPAGE_BPS: z.coerce.number().min(0).max(500).default(10),
    SCHEDULER_ENABLED: bool.default(true),
    SNAPSHOT_RETENTION_DAYS: positive(7),
    CANDLE_MINUTE_RETENTION_DAYS: positive(60),
    CANDLE_AGGREGATE_RETENTION_DAYS: positive(365),
    CANDLE_DAILY_RETENTION_DAYS: positive(1095),
    VOLUME_PROFILE_RETENTION_DAYS: positive(365),
    OPTION_AGGREGATE_RETENTION_DAYS: positive(90),
    NEWS_RETENTION_DAYS: positive(180),
    STORAGE_BUDGET_MB: positive(512),
    STORAGE_WARN_PCT: z.coerce.number().min(1).max(99).default(60),
    STORAGE_REDUCE_PCT: z.coerce.number().min(1).max(99).default(75),
    STORAGE_CRITICAL_PCT: z.coerce.number().min(1).max(100).default(90),
    STORAGE_CHECK_INTERVAL_MS: positive(300000),
    MAX_SNAPSHOT_INSTRUMENTS: z.coerce.number().int().min(0).max(200).default(60),
    SNAPSHOTS_ENABLED: bool.default(true),
    MAX_NEARBY_OPTION_LEGS: z.coerce.number().int().min(2).max(24).default(8),
    VOLUME_LOOKBACK: z.coerce.number().int().min(3).max(120).default(20),
    VOLUME_ANOMALY_Z: positive(2),
    OUTCOME_HORIZON_MINUTES: positive(30),
    VALIDATION_EMBARGO_MINUTES: positive(30),
    GNEWS_API_KEY: z.string().default(''),
    NEWSAPI_KEY: z.string().default(''),
    NEWS_SEARCH_QUERY: z.string().min(1).max(180).default('India RBI NSE earnings'),
    NSE_RSS_URL: optionalUrl,
    RBI_RSS_URL: optionalUrl,
    OLLAMA_BASE_URL: optionalUrl,
    OLLAMA_MODEL: z.string().min(1).max(100).default('qwen3:4b'),
    FINBERT_SERVICE_URL: optionalUrl,
    NEWS_MODEL_TIMEOUT_MS: z.coerce.number().int().min(100).max(120000).default(30000),
    NEWS_MAX_ITEMS: z.coerce.number().int().min(1).max(200).default(40),
    FINBERT_URL: optionalUrl,
    ML_INFERENCE_URL: optionalUrl,
    RSS_FEED_URLS: csv,
    EVENT_CALENDAR_PATH: z.string().default(''),
    REQUIRE_EVENT_CALENDAR: bool.default(true),
  })
  .superRefine((c, ctx) => {
    if (c.DATA_MODE === 'live' && (c.STORAGE_MODE !== 'mongo' || !c.UPSTOX_ANALYTICS_TOKEN))
      ctx.addIssue({ code: 'custom', message: 'Live mode requires MongoDB and UPSTOX_ANALYTICS_TOKEN' });
    if (c.NODE_ENV === 'production' && c.STORAGE_MODE === 'memory')
      ctx.addIssue({ code: 'custom', message: 'Production requires persistent MongoDB' });
    if (c.BASELINE_MIN_SAMPLES > c.BASELINE_SESSIONS)
      ctx.addIssue({ code: 'custom', message: 'Baseline minimum exceeds lookback' });
    if (c.MAX_RISK_PER_TRADE > c.MAX_AGGREGATE_RISK || c.MAX_AGGREGATE_RISK > c.SIMULATED_CAPITAL)
      ctx.addIssue({ code: 'custom', message: 'Risk limits exceed aggregate risk or capital' });
    if (!(c.STORAGE_WARN_PCT < c.STORAGE_REDUCE_PCT && c.STORAGE_REDUCE_PCT < c.STORAGE_CRITICAL_PCT))
      ctx.addIssue({
        code: 'custom',
        message: 'Storage thresholds must increase: warning < reduced < critical',
      });
    if (
      c.CANDLE_AGGREGATE_RETENTION_DAYS < c.CANDLE_MINUTE_RETENTION_DAYS ||
      c.VOLUME_PROFILE_RETENTION_DAYS < Math.ceil(c.BASELINE_SESSIONS * 2.5) ||
      c.OPTION_AGGREGATE_RETENTION_DAYS < c.SNAPSHOT_RETENTION_DAYS
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Derived history retention must cover its sources and baseline lookback',
      });
  });
export type Config = z.infer<typeof configSchema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. Run npm run setup.`,
    );
  return result.data;
}
