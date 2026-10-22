import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
let server = null,
  busy = false,
  queued = false,
  timer = null,
  stopping = false;
function run(args) {
  return spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
}
async function restart() {
  if (stopping) return;
  if (busy) {
    queued = true;
    return;
  }
  busy = true;
  if (server && server.exitCode === null && server.signalCode === null) {
    const old = server;
    server = null;
    await new Promise((resolve) => {
      old.once('exit', resolve);
      old.kill('SIGTERM');
    });
  }
  const compiler = run(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']);
  const code = await new Promise((resolve) => compiler.once('exit', resolve));
  if (code === 0 && !stopping) server = run(['dist/src/server.js']);
  busy = false;
  if (queued) {
    queued = false;
    void restart();
  }
}
const watcher = watch('src', { recursive: true }, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void restart(), 250);
});
function stop() {
  stopping = true;
  watcher.close();
  if (timer) clearTimeout(timer);
  server?.kill('SIGTERM');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
void restart();
