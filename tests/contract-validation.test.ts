import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fixture, TEST_PASSWORD } from './helpers.js';
import { createApp } from '../src/api/app.js';
import { openapi } from '../src/api/openapi.js';
import { DEMO_NOW } from '../src/testing/demo.js';
describe('OpenAPI response compatibility', () => {
  it('validates actual API data against every populated read response schema', async () => {
    const s = await fixture(),
      run = await s.analysis.evaluate('INITIAL', DEMO_NOW, DEMO_NOW),
      signalId = run.signalIds[0]!;
    await s.paper.open(signalId, 1, 'contract-test-entry', DEMO_NOW);
    const app = createApp(s);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: 'owner', password: TEST_PASSWORD });
    const token = login.body.data.accessToken as string;
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const cases = [
      ['/auth/me', 'Identity'],
      ['/market', 'Market'],
      ['/market/candles?instrumentKey=DEMO%7CACME', 'Candles'],
      ['/market/volume?instrumentKey=DEMO%7CACME', 'Volume'],
      ['/market/option-chain?instrumentKey=DEMO%7CACME', 'OptionChain'],
      ['/market/regime', 'Regimes'],
      ['/analysis/latest', 'Analysis'],
      ['/analysis/history', 'AnalysisHistory'],
      ['/opportunities', 'Opportunities'],
      [`/opportunities/${signalId}`, 'Opportunity'],
      [`/opportunities/${signalId}/events`, 'Events'],
      ['/strategies', 'Strategies'],
      ['/paper-trades', 'PaperTrades'],
      ['/performance', 'Performance'],
      ['/settings', 'Settings'],
      ['/system/health', 'Health'],
      ['/news', 'News'],
      ['/backtests', 'Backtests'],
    ];
    for (const [path, schema] of cases) {
      const response = await request(app).get(`/api/v1${path}`).auth(token, { type: 'bearer' });
      expect(response.status, path).toBe(200);
      const validate = ajv.compile({
        $ref: `#/components/schemas/${schema}`,
        components: openapi.components,
      });
      expect(validate(response.body.data), `${path}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });
});
