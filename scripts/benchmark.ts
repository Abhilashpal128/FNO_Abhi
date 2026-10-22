import { performance } from 'node:perf_hooks';
import { CumulativeVolumeTracker } from '../src/market/candles.js';
const tracker = new CumulativeVolumeTracker(),
  start = Date.parse('2026-10-21T03:45:00Z'),
  count = 100000;
const before = performance.now();
let volume = 0;
for (let i = 0; i < count; i++)
  volume +=
    tracker.observe(`SYNTHETIC|${i % 100}`, start + Math.floor(i / 100) * 100, Math.floor(i / 100) * 10)
      .volume ?? 0;
const elapsed = performance.now() - before;
if (volume !== (count - 100) * 10) throw new Error('Benchmark volume invariant failed');
process.stdout.write(
  JSON.stringify({
    benchmark: 'Synthetic incremental-volume CPU throughput only',
    observations: count,
    elapsedMs: Math.round(elapsed),
    observationsPerSecond: Math.round((count / elapsed) * 1000),
    expectedVolume: volume,
    databaseAndNetworkIncluded: false,
  }) + '\n',
);
