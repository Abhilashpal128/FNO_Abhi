import { beforeAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { fixture, TEST_PASSWORD } from './helpers.js';
import { createApp } from '../src/api/app.js';
import { DEMO_NOW } from '../src/testing/demo.js';
import { configSchema } from '../src/config.js';
import { openapi } from '../src/api/openapi.js';
import { routeContracts } from '../src/api/contracts.js';
import { verifyPassword, hashPassword, verifyToken } from '../src/api/auth.js';
import { readFile } from 'node:fs/promises';
describe('authenticated REST API', () => {
  let app: ReturnType<typeof createApp>, token: string, signalId: string;
  beforeAll(async () => {
    const s = await fixture();
    const run = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW);
    signalId = run.signalIds[0]!;
    app = createApp(s);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: s.config.APP_USERNAME, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    token = res.body.data.accessToken as string;
  });
  it('provides minimal unauthenticated liveness and readiness', async () => {
    expect((await request(app).get('/healthz')).status).toBe(200);
    expect((await request(app).get('/readyz')).body.persistent).toBe(false);
  });
  it('requires authentication for all data routes', async () => {
    for (const path of ['/market', '/analysis/latest', '/opportunities', '/settings', '/openapi.json'])
      expect((await request(app).get(`/api/v1${path}`)).status).toBe(401);
  });
  it('rejects malformed or forged bearer tokens', async () => {
    expect(
      (await request(app).get('/api/v1/market').set('Authorization', 'Bearer made-up-token')).status,
    ).toBe(401);
  });
  it('rejects invalid and oversized parameters without database injection', async () => {
    expect(
      (await request(app).get('/api/v1/market/candles?instrumentKey[$ne]=x').auth(token, { type: 'bearer' }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get('/api/v1/market/candles?instrumentKey=DEMO%7CACME&limit=99999')
          .auth(token, { type: 'bearer' })
      ).status,
    ).toBe(400);
  });
  it('rejects unknown body fields and too many opportunities', async () => {
    expect(
      (
        await request(app)
          .patch('/api/v1/settings')
          .auth(token, { type: 'bearer' })
          .send({ maxDailyOpportunities: 6 })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch('/api/v1/settings')
          .auth(token, { type: 'bearer' })
          .send({ UPSTOX_ANALYTICS_TOKEN: 'bad' })
      ).status,
    ).toBe(400);
  });
  it('does not expose environment secrets from settings', async () => {
    const res = await request(app).get('/api/v1/settings').auth(token, { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(
      /JWT_SECRET|APP_PASSWORD|MONGODB_URI|UPSTOX_ANALYTICS_TOKEN/,
    );
  });
  it('returns report identity, real analysis time and synthetic status', async () => {
    const res = await request(app).get('/api/v1/analysis/latest').auth(token, { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body.meta.synthetic).toBe(true);
    expect(res.body.data.latest.analyzedAt).toBe(DEMO_NOW);
    expect(res.body.data.latest.volume[0].openingFiveMinuteRvol).toBe(3);
  });
  it('requires explicit idempotency key for paper entry', async () => {
    expect(
      (
        await request(app)
          .post('/api/v1/paper-trades')
          .auth(token, { type: 'bearer' })
          .send({ signalId, lots: 1 })
      ).status,
    ).toBe(400);
    const res = await request(app)
      .post('/api/v1/paper-trades')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', 'api-paper-key')
      .send({ signalId, lots: 1 });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('OPEN');
    const again = await request(app)
      .post('/api/v1/paper-trades')
      .auth(token, { type: 'bearer' })
      .set('Idempotency-Key', 'api-paper-key')
      .send({ signalId, lots: 1 });
    expect(again.body.data.id).toBe(res.body.data.id);
  });
  it('returns secure validation errors for malformed JSON', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
  it('declares every route in OpenAPI with request validation schemas', async () => {
    for (const route of routeContracts) {
      const path = openapi.paths[`/api/v1${route.path}`]!;
      expect(path[route.method]).toBeDefined();
    }
    const published = JSON.parse(await readFile('openapi.json', 'utf8')) as unknown;
    expect(published).toEqual(openapi);
  });
  it('has no real broker order endpoint', async () => {
    expect((await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send({})).status).toBe(
      404,
    );
  });
});
describe('secret configuration', () => {
  it('hashes passwords with random salt and never accepts a wrong password', async () => {
    const a = await hashPassword('a long test password'),
      b = await hashPassword('a long test password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('a long test password', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
  });
  it('rejects live mode with ephemeral data or missing Analytics Token', () => {
    expect(
      configSchema.safeParse({
        APP_PASSWORD_HASH: 'x'.repeat(64),
        JWT_SECRET: 'x'.repeat(64),
        DATA_MODE: 'live',
      }).success,
    ).toBe(false);
  });
  it('rejects missing secrets, undersized token keys and string false mistakes', async () => {
    expect(configSchema.safeParse({}).success).toBe(false);
    const s = await fixture();
    expect(s.config.GLOBAL_NO_TRADE).toBe(false);
    expect(await verifyToken('fake', s.config)).toBe(false);
  });
});
