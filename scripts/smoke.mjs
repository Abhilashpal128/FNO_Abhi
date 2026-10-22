import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { hashPassword } from '../dist/src/api/auth.js';

// Exercise the compiled entry point with temporary credentials and an isolated memory store.
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const password = randomBytes(32).toString('base64url');
const child = spawn(process.execPath, ['dist/scripts/demo.js'], {
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOG_LEVEL: 'silent',
    APP_USERNAME: 'smoke-owner',
    APP_PASSWORD_HASH: await hashPassword(password),
    JWT_SECRET: randomBytes(48).toString('base64url'),
    GLOBAL_NO_TRADE: 'false',
  },
});
child.stderr.resume();
const exited = once(child, 'exit');
const base = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error('Compiled demo exited before becoming ready');
    try {
      ready = (await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      /* startup */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'Compiled demo readiness');
  assert.equal((await fetch(`${base}/api/v1/analysis/latest`)).status, 401);
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-owner', password }),
  });
  assert.equal(login.status, 200);
  const headers = { Authorization: `Bearer ${(await login.json()).data.accessToken}` };
  const response = await fetch(`${base}/api/v1/analysis/latest`, { headers });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.meta.synthetic, true);
  assert.equal(report.data.latest.status, 'OPPORTUNITIES');
  assert.equal(report.data.latest.signalIds.length, 1);
  const entry = await fetch(`${base}/api/v1/paper-trades`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': 'compiled-smoke-entry' },
    body: JSON.stringify({ signalId: report.data.latest.signalIds[0], lots: 1 }),
  });
  assert.equal(entry.status, 201);
  assert.equal((await entry.json()).data.status, 'OPEN');
  const specification = await fetch(`${base}/api/v1/openapi.json`, { headers });
  assert.equal(specification.status, 200);
  process.stdout.write(
    'Compiled demo smoke passed: readiness, authentication, synthetic report, paper entry and OpenAPI.\n',
  );
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await exited;
}
