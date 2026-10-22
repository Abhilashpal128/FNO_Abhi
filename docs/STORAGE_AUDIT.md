# Storage audit — 22 October 2026

Inspected `services/market.ts`, `db/store.ts`, `db/models.ts`, `services/scheduler.ts`, and analysis/paper monitors before changes.

- `acceptQuote` kept latest quotes in memory, but inserted `option_snapshots` every 1,000 ms per instrument. It was not literally every WebSocket frame; it could still produce 22,500 records per symbol during a 375-minute session. It also attempted an instrument-version insert on the first quote per metadata version.
- The cumulative tracker handled first observations, resets, corrections, gaps and out-of-order ticks. Sampled candle OHLC was flagged and reconciled against completed broker OHLC. Index spot volume remained null.
- Completed candles had unique instrument/interval/start indexes. Quote IDs included source and receipt timestamps, so retransmitted data with a new receipt could be stored again. There was no durable per-minute snapshot bound across restart.
- Only option snapshots had TTL (180 days by default). Candles, volume profiles and article metadata had no retention. Essential signals, executions and reports were intentionally permanent.
- Candle/history writes already used bounded bulk upserts; correctable candles used ordinary collections. Append-only decision records had mutation guards and unique daily signal limits.
- There was no database-size/growth monitor, storage-budget backpressure, or verified archive workflow. `system_health` checked connectivity and application components, not disk consumption.

The update replaces the per-second snapshot write path with selected completed-minute sampling and five-minute compact observations, introduces guarded retention and storage-budget monitoring, and preserves original audit records. Tests and the implementation status document describe verification of the new behaviour; these findings describe the pre-update source.
