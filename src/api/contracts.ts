import { z } from 'zod';
export const instrumentKey = z
  .string()
  .min(3)
  .max(150)
  .regex(/^[A-Za-z0-9_ |.:-]+$/);
export const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_|.:-]+$/);
export const schemas = {
  login: z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(512) }).strict(),
  refresh: z.object({}).strict(),
  candles: z
    .object({
      instrumentKey,
      interval: z.coerce
        .number()
        .pipe(z.union([z.literal(1), z.literal(5), z.literal(15), z.literal(30), z.literal(1440)]))
        .default(5),
      from: z.coerce.number().int().positive().optional(),
      to: z.coerce.number().int().positive().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
    })
    .strict(),
  key: z.object({ instrumentKey }).strict(),
  chain: z
    .object({
      instrumentKey,
      expiry: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
    })
    .strict(),
  pagination: z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(20),
      before: z.coerce.number().int().positive().optional(),
    })
    .strict(),
  openTrade: z.object({ signalId: idSchema, lots: z.number().int().min(1).max(100) }).strict(),
  settings: z
    .object({
      globalNoTrade: z.boolean().optional(),
      maxRiskPerTrade: z.number().positive().max(10000000).optional(),
      maxDailyLoss: z.number().positive().max(10000000).optional(),
      maxAggregateRisk: z.number().positive().max(10000000).optional(),
      maxCorrelatedRisk: z.number().positive().max(10000000).optional(),
      maxDailyOpportunities: z.number().int().min(1).max(5).optional(),
    })
    .strict(),
  backtest: z
    .object({
      underlyingKey: instrumentKey,
      contractKey: instrumentKey,
      from: z.number().int().positive(),
      to: z.number().int().positive(),
    })
    .strict()
    .refine((v) => v.to > v.from && v.to - v.from <= 90 * 86400000, {
      message: 'Use a positive range of at most 90 days',
    }),
};
export interface RouteContract {
  method: 'get' | 'post' | 'patch';
  path: string;
  summary: string;
  body?: keyof typeof schemas;
  query?: keyof typeof schemas;
  response: string;
  status?: number;
}
export const routeContracts: RouteContract[] = [
  {
    method: 'get',
    path: '/market/features',
    summary: 'Latest derived volume features',
    query: 'key',
    response: 'MarketFeature',
  },
  {
    method: 'get',
    path: '/market/option-observations',
    summary: 'Compact five-minute sampled option observations, not executable OHLC',
    query: 'key',
    response: 'OptionAggregates',
  },
  {
    method: 'get',
    path: '/strategies/decisions',
    summary: 'Versioned individual strategy decisions and rejection reasons',
    query: 'key',
    response: 'StrategyDecisions',
  },
  {
    method: 'get',
    path: '/news/briefings/latest',
    summary: 'Latest immutable source-grounded news briefing with cutoff and degraded state',
    response: 'Briefing',
  },
  {
    method: 'get',
    path: '/news/briefings',
    summary: 'Versioned news briefing history',
    query: 'pagination',
    response: 'Briefings',
  },
  {
    method: 'get',
    path: '/research/outcomes',
    summary: 'Candidate target-before-stop evidence, distinct from paper execution',
    query: 'pagination',
    response: 'ResearchOutcomes',
  },
  {
    method: 'get',
    path: '/research/quality',
    summary: 'Measured coverage, outcome precision and execution costs',
    response: 'ResearchQuality',
  },
  {
    method: 'get',
    path: '/models/validation',
    summary: 'Stored chronological validation reports; no automatic model promotion',
    response: 'ValidationReports',
  },
  {
    method: 'get',
    path: '/models/drift',
    summary: 'Observed feature distribution drift, null without sufficient samples',
    response: 'ModelDrift',
  },
  {
    method: 'post',
    path: '/auth/login',
    summary: 'Single-user login; short-lived bearer token',
    body: 'login',
    response: 'AuthToken',
  },
  { method: 'get', path: '/auth/me', summary: 'Authenticated account identity', response: 'Identity' },
  {
    method: 'get',
    path: '/market',
    summary: 'Session, underlying universe and latest quote metadata',
    response: 'Market',
  },
  {
    method: 'get',
    path: '/market/candles',
    summary: 'Completed stored candles; bounded time range',
    query: 'candles',
    response: 'Candles',
  },
  {
    method: 'get',
    path: '/market/volume',
    summary: 'Same-time historical volume intelligence',
    query: 'key',
    response: 'Volume',
  },
  {
    method: 'get',
    path: '/market/option-chain',
    summary: 'Listed contract metadata and latest collected quotes',
    query: 'chain',
    response: 'OptionChain',
  },
  { method: 'get', path: '/market/regime', summary: 'Latest market regimes', response: 'Regimes' },
  {
    method: 'get',
    path: '/news',
    summary: 'Collected news as known at server analysis clock',
    query: 'pagination',
    response: 'News',
  },
  {
    method: 'get',
    path: '/analysis/latest',
    summary: 'Most recent evaluation including original 9:20 report reference',
    response: 'Analysis',
  },
  {
    method: 'get',
    path: '/analysis/history',
    summary: 'Immutable evaluation history',
    query: 'pagination',
    response: 'AnalysisHistory',
  },
  {
    method: 'post',
    path: '/analysis/refresh',
    summary: 'Evaluate current collected data without weakening risk gates',
    body: 'refresh',
    response: 'Analysis',
  },
  {
    method: 'get',
    path: '/opportunities',
    summary: 'At most five original daily opportunities plus current status',
    response: 'Opportunities',
  },
  {
    method: 'get',
    path: '/opportunities/{id}',
    summary: 'Immutable decision snapshot and latest status',
    response: 'Opportunity',
  },
  {
    method: 'get',
    path: '/opportunities/{id}/events',
    summary: 'Append-only research lifecycle',
    response: 'Events',
  },
  {
    method: 'get',
    path: '/strategies',
    summary: 'Versioned strategy definitions and validation status',
    response: 'Strategies',
  },
  { method: 'get', path: '/paper-trades', summary: 'Simulated positions and fills', response: 'PaperTrades' },
  {
    method: 'post',
    path: '/paper-trades',
    summary: 'Explicit simulated entry; requires Idempotency-Key',
    body: 'openTrade',
    response: 'PaperTrade',
    status: 201,
  },
  {
    method: 'post',
    path: '/paper-trades/{id}/close',
    summary: 'Simulated exit at a fresh executable bid',
    body: 'refresh',
    response: 'PaperTrade',
  },
  {
    method: 'get',
    path: '/backtests',
    summary: 'Stored historical replay results',
    query: 'pagination',
    response: 'Backtests',
  },
  {
    method: 'post',
    path: '/backtests',
    summary: 'Replay recorded point-in-time data; no fabricated expired quotes',
    body: 'backtest',
    response: 'Backtest',
    status: 201,
  },
  {
    method: 'get',
    path: '/backtests/{id}',
    summary: 'Replay metrics, trades and limitations',
    response: 'Backtest',
  },
  {
    method: 'get',
    path: '/performance',
    summary: 'Paper account, net outcomes and current marks',
    response: 'Performance',
  },
  {
    method: 'get',
    path: '/settings',
    summary: 'Risk settings; never returns environment secrets',
    response: 'Settings',
  },
  {
    method: 'patch',
    path: '/settings',
    summary: 'Validate and atomically update risk limits',
    body: 'settings',
    response: 'Settings',
  },
  {
    method: 'get',
    path: '/system/health',
    summary: 'Database, feed, scheduler and data-quality health',
    response: 'Health',
  },
];
