import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Store } from '../db/store.js';
import { ConflictError } from '../db/store.js';
import type { MarketService } from '../services/market.js';
import { AnalysisService, latestEvent } from '../services/analysis.js';
import { PaperService, DomainError } from '../services/paper.js';
import { dayKey, fresh } from '../market/time.js';
import { runBacktest } from '../engines/backtest.js';
import { derivativesVolume, putCallRatio } from '../engines/volume.js';
import { volumeWindows } from '../engines/volume-windows.js';
import { schemas, idSchema } from './contracts.js';
import { issueToken, verifyPassword, verifyToken } from './auth.js';
import { openapi } from './openapi.js';
import type { StorageHealthService } from '../services/storage.js';
import { ResearchQualityService } from '../services/quality.js';
import { advancedVolume } from '../engines/advanced-volume.js';
export interface Services {
  storage?: StorageHealthService;
  quality?: ResearchQualityService;
  store: Store;
  market: MarketService;
  analysis: AnalysisService;
  paper: PaperService;
  config: Config;
  log: Logger;
  now: () => number;
}
export function createApp(s: Services) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', s.config.TRUST_PROXY_HOPS);
  app.use(helmet());
  app.use(cors({ origin: s.config.CORS_ORIGINS, credentials: false }));
  app.use(express.json({ limit: '64kb' }));
  app.use(
    pinoHttp({
      logger: s.log,
      genReqId: () => randomUUID(),
      serializers: {
        req: (r) => ({ id: r.id, method: r.method, url: String(r.url).split('?')[0] }),
        res: (r) => ({ statusCode: r.statusCode }),
      },
    }),
  );
  const limiter = (windowMs: number, limit: number) =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'RATE_LIMITED', message: 'Request rate exceeded; retry later' } },
    });
  app.use(limiter(60000, 120));
  app.get('/healthz', (_req, res) =>
    res.json({ status: 'OK', service: 'stockss-intelligence', mode: s.config.DATA_MODE }),
  );
  app.get('/readyz', async (_req, res) => {
    const db = await s.store.healthy();
    res.status(db ? 200 : 503).json({ ready: db, mode: s.config.DATA_MODE, persistent: s.store.persistent });
  });
  const router = express.Router();
  const respond = (res: Response, data: unknown, status = 200) =>
    res.status(status).json({
      data,
      meta: {
        mode: s.config.DATA_MODE,
        serverTime: new Date().toISOString(),
        analysisClock: new Date(s.now()).toISOString(),
        synthetic: s.config.DATA_MODE === 'demo',
      },
    });
  router.post('/auth/login', limiter(15 * 60000, 10), async (req, res) => {
    const body = schemas.login.parse(req.body);
    const a = Buffer.from(body.username),
      b = Buffer.from(s.config.APP_USERNAME);
    const username = a.length === b.length && timingSafeEqual(a, b);
    const password = await verifyPassword(body.password, s.config.APP_PASSWORD_HASH);
    if (!username || !password) throw new DomainError('INVALID_CREDENTIALS', [], 401);
    respond(res, {
      accessToken: await issueToken(s.config),
      tokenType: 'Bearer',
      expiresIn: s.config.TOKEN_TTL_SECONDS,
    });
  });
  router.use(async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ') || !(await verifyToken(auth.slice(7), s.config))) {
      res
        .status(401)
        .json({ error: { code: 'UNAUTHORIZED', message: 'Valid bearer authentication required' } });
      return;
    }
    next();
  });
  router.get('/auth/me', (_req, res) =>
    respond(res, { username: s.config.APP_USERNAME, scope: 'research:owner' }),
  );
  router.get('/openapi.json', (_req, res) => res.json(openapi));
  router.get('/market', (_req, res) =>
    respond(res, {
      session: s.market.session,
      underlyings: s.market.underlyings,
      volumeProxies: Object.fromEntries(s.market.volumeKeys),
      quotes: [...s.market.quotes.values()].map((q) => ({
        ...q,
        fresh: fresh(q.sourceTs, q.receivedAt, s.now(), s.config.QUOTE_MAX_AGE_MS),
      })),
      feed: s.market.feed?.status() ?? null,
    }),
  );
  router.get('/market/candles', async (req, res) => {
    const q = schemas.candles.parse(req.query);
    if (q.from && q.to && q.to < q.from) throw new DomainError('INVALID_TIME_RANGE', [], 400);
    respond(
      res,
      await s.store.find(
        'market_candles',
        {
          instrumentKey: q.instrumentKey,
          interval: q.interval,
          complete: true,
          end: { $lte: Math.min(q.to ?? s.now(), s.now()) },
          ...(q.from ? { start: { $gte: q.from } } : {}),
        },
        { sort: { start: -1 }, limit: q.limit },
      ),
    );
  });
  router.get('/market/volume', async (req, res) => {
    const q = schemas.key.parse(req.query),
      key = s.market.volumeKeys.get(q.instrumentKey) ?? q.instrumentKey;
    const rows = await s.store.find(
        'market_candles',
        { instrumentKey: key, end: { $lte: s.now() } },
        { sort: { end: -1 }, limit: 10000 },
      ),
      profiles = await s.store.find(
        'market_volume_profiles',
        { instrumentKey: key },
        { sort: { day: -1 }, limit: 20000 },
      );
    respond(res, {
      features: await s.analysis.volumes(key),
      advanced: advancedVolume(
        rows,
        profiles,
        s.now(),
        s.config,
        rows.find((c) => c.interval === 5 && c.start === s.market.session?.open) ?? null,
      ),
      volumeInstrumentKey: key,
      windows: volumeWindows(
        rows,
        profiles,
        s.market.session,
        s.market.quotes.get(key) ?? null,
        s.now(),
        s.config,
      ),
    });
  });
  router.get('/market/option-chain', async (req, res) => {
    const q = schemas.chain.parse(req.query),
      contracts = await s.store.find(
        'instruments',
        {
          underlyingKey: q.instrumentKey,
          kind: { $in: ['CE', 'PE'] },
          active: true,
          ...(q.expiry ? { expiry: q.expiry } : {}),
        },
        { sort: { expiry: 1, strike: 1 }, limit: 1000 },
      );
    const rows = contracts.map((i) => {
      const quote = s.market.quotes.get(i.id) ?? null;
      return { contract: i, quote, derivatives: quote ? derivativesVolume(quote, s.now()) : null };
    });
    const expiry = q.expiry ?? contracts[0]?.expiry;
    respond(res, {
      contracts: rows,
      pcr: putCallRatio(
        rows
          .filter((r) => r.contract.expiry === expiry && r.contract.kind === 'CE' && r.quote)
          .map((r) => r.quote!),
        rows
          .filter((r) => r.contract.expiry === expiry && r.contract.kind === 'PE' && r.quote)
          .map((r) => r.quote!),
      ),
      pcrExpiry: expiry ?? null,
      limitations: ['PCR covers only collected strikes; missing contracts are not assumed zero'],
    });
  });
  router.get('/market/regime', async (_req, res) =>
    respond(res, await s.store.find('market_regimes', {}, { sort: { asOf: -1 }, limit: 50 })),
  );
  router.get('/news', async (req, res) => {
    const q = schemas.pagination.parse(req.query);
    respond(
      res,
      await s.store.find(
        'market_news',
        { publishedAt: { $lte: Math.min(q.before ?? s.now(), s.now()) }, receivedAt: { $lte: s.now() } },
        { sort: { publishedAt: -1 }, limit: q.limit },
      ),
    );
  });
  router.get('/analysis/latest', async (_req, res) =>
    respond(res, { latest: await s.analysis.latest(), initial: await s.analysis.latest(true) }),
  );
  router.get('/analysis/history', async (req, res) => {
    const q = schemas.pagination.parse(req.query);
    respond(
      res,
      await s.store.find('analysis_runs', q.before ? { analyzedAt: { $lt: q.before } } : {}, {
        sort: { analyzedAt: -1 },
        limit: q.limit,
      }),
    );
  });
  router.post('/analysis/refresh', limiter(60000, 2), async (req, res) => {
    schemas.refresh.parse(req.body ?? {});
    const now = s.now();
    respond(res, await s.analysis.evaluate('MANUAL', now, now));
  });
  router.get('/opportunities', async (_req, res) => {
    const opportunities = await s.store.find(
      'trade_signals',
      { day: dayKey(s.now()) },
      { sort: { slot: 1 }, limit: 5 },
    );
    respond(
      res,
      await Promise.all(
        opportunities.map(async (o) => ({
          ...o,
          currentStatus: (await latestEvent(s.store, o.id))?.status ?? 'WATCHING',
        })),
      ),
    );
  });
  router.get('/opportunities/:id/events', async (req, res) => {
    const id = idSchema.parse(req.params.id);
    respond(res, await s.store.find('signal_events', { signalId: id }, { sort: { timestamp: 1 } }));
  });
  router.get('/opportunities/:id', async (req, res) => {
    const id = idSchema.parse(req.params.id),
      opportunity = await s.store.get('trade_signals', id);
    if (!opportunity) throw new DomainError('NOT_FOUND', [], 404);
    respond(res, { ...opportunity, currentStatus: (await latestEvent(s.store, id))?.status ?? 'WATCHING' });
  });
  router.get('/strategies', async (_req, res) => respond(res, await s.store.find('strategy_definitions')));
  router.get('/strategies/decisions', async (req, res) => {
    const q = schemas.key.parse(req.query);
    respond(
      res,
      await s.store.find(
        'strategy_decisions',
        { instrumentKey: q.instrumentKey },
        { sort: { asOf: -1 }, limit: 50 },
      ),
    );
  });
  router.get('/market/features', async (req, res) => {
    const q = schemas.key.parse(req.query);
    respond(res, await s.store.get('market_features', q.instrumentKey));
  });
  router.get('/market/option-observations', async (req, res) => {
    const q = schemas.key.parse(req.query);
    respond(
      res,
      await s.store.find(
        'option_aggregates',
        { instrumentKey: q.instrumentKey, end: { $lte: s.now() } },
        { sort: { start: -1 }, limit: 100 },
      ),
    );
  });
  router.get('/news/briefings/latest', async (_req, res) =>
    respond(
      res,
      (await s.store.find('news_briefings', {}, { sort: { cutoff: -1, createdAt: -1 }, limit: 1 }))[0] ??
        null,
    ),
  );
  router.get('/news/briefings', async (req, res) => {
    const q = schemas.pagination.parse(req.query);
    respond(
      res,
      await s.store.find('news_briefings', q.before ? { createdAt: { $lt: q.before } } : {}, {
        sort: { createdAt: -1 },
        limit: q.limit,
      }),
    );
  });
  router.get('/research/outcomes', async (req, res) => {
    const q = schemas.pagination.parse(req.query);
    respond(
      res,
      await s.store.find('research_outcomes', q.before ? { candidateAt: { $lt: q.before } } : {}, {
        sort: { candidateAt: -1 },
        limit: q.limit,
      }),
    );
  });
  router.get('/research/quality', async (_req, res) =>
    respond(res, await (s.quality ?? new ResearchQualityService(s.store, s.config)).report()),
  );
  router.get('/models/validation', async (_req, res) =>
    respond(res, await s.store.find('validation_reports', {}, { sort: { createdAt: -1 }, limit: 20 })),
  );
  router.get('/models/drift', async (_req, res) =>
    respond(res, await (s.quality ?? new ResearchQualityService(s.store, s.config)).drift()),
  );
  router.get('/paper-trades', async (_req, res) =>
    respond(res, await s.store.find('paper_trades', {}, { sort: { openedAt: -1 }, limit: 100 })),
  );
  router.post('/paper-trades', async (req, res) => {
    const body = schemas.openTrade.parse(req.body),
      key = z
        .string()
        .min(8)
        .max(128)
        .regex(/^[A-Za-z0-9_-]+$/)
        .parse(req.header('Idempotency-Key'));
    respond(res, await s.paper.open(body.signalId, body.lots, key, s.now()), 201);
  });
  router.post('/paper-trades/:id/close', async (req, res) => {
    schemas.refresh.parse(req.body ?? {});
    respond(res, await s.paper.close(idSchema.parse(req.params.id), s.now()));
  });
  router.get('/performance', async (_req, res) => respond(res, await s.paper.report(s.now())));
  router.get('/backtests', async (req, res) => {
    const q = schemas.pagination.parse(req.query);
    respond(
      res,
      await s.store.find('backtest_runs', q.before ? { createdAt: { $lt: q.before } } : {}, {
        sort: { createdAt: -1 },
        limit: q.limit,
      }),
    );
  });
  router.post('/backtests', limiter(60000, 2), async (req, res) => {
    const body = schemas.backtest.parse(req.body);
    if (body.to > s.now()) throw new DomainError('FUTURE_BACKTEST_RANGE', [], 400);
    const underlying = await s.store.get('instruments', body.underlyingKey),
      contract = await s.store.get('instruments', body.contractKey);
    if (!underlying || !contract || contract.underlyingKey !== underlying.id)
      throw new DomainError('CONTRACT_MAPPING_UNAVAILABLE', [], 422);
    const volumeKey = s.market.volumeKeys.get(underlying.id) ?? underlying.id;
    const bars = await s.store.find(
      'market_candles',
      {
        instrumentKey: underlying.id,
        interval: 1,
        start: { $gte: body.from - 7 * 86400000 },
        end: { $lte: body.to },
      },
      { sort: { start: 1 }, limit: 50000 },
    );
    const volume =
      volumeKey === underlying.id
        ? bars
        : await s.store.find(
            'market_candles',
            {
              instrumentKey: volumeKey,
              interval: 1,
              start: { $gte: body.from - 7 * 86400000 },
              end: { $lte: body.to },
            },
            { sort: { start: 1 }, limit: 50000 },
          );
    const quotes = await s.store.find(
      'option_snapshots',
      { instrumentKey: contract.id, sourceTs: { $gte: body.from, $lte: body.to } },
      { sort: { sourceTs: 1 }, limit: 100000 },
    );
    if (quotes.length === 100000)
      throw new DomainError('REPLAY_RANGE_TOO_LARGE', ['Narrow the range; refusing silent truncation'], 422);
    const profiles = await s.store.find(
      'market_volume_profiles',
      { instrumentKey: volumeKey },
      { limit: 20000 },
    );
    const result = runBacktest(
      {
        id: randomUUID(),
        underlying,
        contract,
        underlyingCandles: bars,
        volumeCandles: volume,
        profiles,
        quotes,
        futureQuotes: volumeKey === underlying.id ? [] : await s.store.find('option_snapshots',
          { instrumentKey: volumeKey, sourceTs: { $gte: body.from - 120000, $lte: body.to } },
          { sort: { sourceTs: 1 }, limit: 100000 }),
        from: body.from,
        to: body.to,
        createdAt: s.now(),
        eventCalendarReady: false,
        news: await s.store.find(
          'market_news',
          { receivedAt: { $lte: body.to }, publishedAt: { $gte: body.from - 86400000, $lte: body.to } },
          { sort: { publishedAt: 1 }, limit: 10000 },
        ),
        instrumentVersions: await s.store.find(
          'instrument_versions',
          { instrumentKey: { $in: [underlying.id, contract.id] }, asOf: { $lte: body.to } },
          { sort: { asOf: 1 }, limit: 10000 },
        ),
        eventCalendars: await s.store.find(
          'event_calendar_versions',
          { receivedAt: { $lte: body.to }, validUntil: { $gte: dayKey(body.from) } },
          { sort: { receivedAt: 1 }, limit: 10000 },
        ),
        sessions: await s.store.find('market_sessions', {
          day: { $gte: dayKey(body.from), $lte: dayKey(body.to) },
        }),
      },
      s.config,
    );
    await s.store.insert('backtest_runs', result);
    respond(res, result, 201);
  });
  router.get('/backtests/:id', async (req, res) => {
    const result = await s.store.get('backtest_runs', idSchema.parse(req.params.id));
    if (!result) throw new DomainError('NOT_FOUND', [], 404);
    respond(res, result);
  });
  router.get('/settings', async (_req, res) =>
    respond(res, {
      risk: await s.store.get('risk_settings', 'owner'),
      costAssumptionsVerified: s.config.COSTS_VERIFIED,
      environmentKillSwitch: s.config.GLOBAL_NO_TRADE,
    }),
  );
  router.patch('/settings', async (req, res) => {
    const patch = schemas.settings.parse(req.body);
    const updated = await s.store.transaction(async (db) => {
      const old = (await db.get('risk_settings', 'owner'))!,
        next = { ...old, ...patch, updatedAt: s.now() },
        account = (await db.get('private_accounts', 'owner'))!;
      if (
        next.maxRiskPerTrade > next.maxAggregateRisk ||
        next.maxAggregateRisk > account.capital ||
        next.maxCorrelatedRisk > next.maxAggregateRisk ||
        next.maxDailyLoss > account.capital
      )
        throw new DomainError('INVALID_RISK_LIMITS', [], 400);
      await db.put('risk_settings', next);
      return next;
    });
    respond(res, updated);
  });
  router.get('/system/health', async (_req, res) =>
    respond(res, {
      database: await s.store.healthy(),
      persistent: s.store.persistent,
      feed: s.market.feed?.status() ?? null,
      components: await s.store.find('system_health'),
      storage:
        s.storage?.latest ??
        (await s.store.find('storage_health', {}, { sort: { checkedAt: -1 }, limit: 1 }))[0] ??
        null,
      calendar: s.market.session,
      qualityLimitations: (await s.analysis.latest())?.qualityLimitations ?? ['NO_ANALYSIS_YET'],
    }),
  );
  app.use('/api/v1', router);
  app.use((_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    if (error instanceof DomainError) {
      res
        .status(error.status)
        .json({ error: { code: error.code, message: error.code, reasons: error.reasons } });
      return;
    }
    if (error instanceof ConflictError) {
      res.status(409).json({ error: { code: 'CONFLICT', message: 'Duplicate operation' } });
      return;
    }
    if (error instanceof SyntaxError && 'body' in error) {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON request' } });
      return;
    }
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'JSON request exceeds 64 KB' } });
      return;
    }
    s.log.error({ errorType: error instanceof Error ? error.name : 'UnknownError' }, 'Request failed');
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Request could not be completed' } });
  });
  return app;
}
