import express from 'express';
import { loadConfig } from './src/config.js';
import { createRuntime } from './src/runtime.js';
import { createApp } from './src/api/app.js';
import { RequestDataService } from './src/services/request-data.js';

// Vercel entry point; src/server.ts remains the persistent local worker.
let initialized: Promise<ReturnType<typeof createApp>> | undefined;
function application() {
  initialized ??= (async () => {
    const config = loadConfig({ ...process.env, NODE_ENV: 'production', SCHEDULER_ENABLED: 'false' });
    const runtime = await createRuntime(config);
    const data = new RequestDataService(runtime);
    return createApp({ ...runtime, runtime: 'vercel', beforeRequest: (path, method) => data.refresh(path, method) });
  })().catch(() => {
    initialized = undefined;
    throw new Error('Backend initialization unavailable');
  });
  return initialized;
}
const app = express();
app.disable('x-powered-by');
app.use(async (req, res) => {
  try { (await application())(req, res); }
  catch {
    res.status(503).json({ error: { code: 'BACKEND_UNAVAILABLE', message: 'Check required environment variables and MongoDB connectivity' } });
  }
});
export default app;
