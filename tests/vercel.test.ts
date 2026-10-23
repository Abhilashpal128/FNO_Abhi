import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { fixture } from './helpers.js';
import { ResearchQualityService } from '../src/services/quality.js';
import { StorageHealthService } from '../src/services/storage.js';
const factory = vi.hoisted(() => vi.fn());
vi.mock('../src/runtime.js', () => ({ createRuntime: factory }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  factory.mockReset();
});
async function configure() {
  const s = await fixture();
  vi.stubEnv('DATA_MODE', 'live');
  vi.stubEnv('STORAGE_MODE', 'mongo');
  vi.stubEnv('UPSTOX_ANALYTICS_TOKEN', 'fixture-token');
  vi.stubEnv('APP_PASSWORD_HASH', s.config.APP_PASSWORD_HASH);
  vi.stubEnv('JWT_SECRET', s.config.JWT_SECRET);
  factory.mockResolvedValue({
    ...s,
    provider: null,
    quality: new ResearchQualityService(s.store, s.config),
    storage: new StorageHealthService(s.store, s.market, s.config),
  });
  return (await import('../app.js')).default;
}
describe('Vercel Express export', () => {
  it('shares initialization between concurrent requests and forces the scheduler off', async () => {
    const app = await configure();
    const responses = await Promise.all([request(app).get('/healthz'), request(app).get('/readyz')]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0]?.body.ai.status).toBe('DISABLED');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0]?.[0]).toMatchObject({
      NODE_ENV: 'production',
      DATA_MODE: 'live',
      SCHEDULER_ENABLED: false,
    });
  });
  it('redacts initialization failures and retries on the next request', async () => {
    const app = await configure();
    factory.mockRejectedValueOnce(new Error('mongodb://private-user:private-password@private-host'));
    const failed = await request(app).get('/readyz');
    expect(failed.status).toBe(503);
    expect(failed.text).not.toContain('private-');
    expect((await request(app).get('/readyz')).status).toBe(200);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
