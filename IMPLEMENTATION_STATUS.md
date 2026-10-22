# Implementation status

Updated **22 October 2026**. The existing backend now includes advanced volume research, optional news/model workers, option-outcome evaluation and bounded storage. Real broker operation and trading accuracy have not been validated. No real order execution is implemented.

## Delivered

| Area                 | Implemented behaviour                                                                                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application/security | Strict TypeScript, Express, validated environment, owner authentication, rate limits, redaction, existing API and demo preserved                                                        |
| Market collection    | Existing read-only Upstox adapters, session-aware scheduling, continuous V3 feed, memory quote/cumulative-volume state and completed candles                                            |
| Low-cost persistence | Selected minute quote sampling, deterministic IDs, bounded batches, compact five-minute observations and capped selection                                                               |
| Volume               | Existing multi-timeframe/same-time RVOL plus mean/SD/z-score, acceleration, approximate VWAP, OBV, ADL, divergence, breakout/rejection and participation hypotheses                     |
| Strategies           | Ten additions plus preserved opening strategy and EMA baseline; versioned eligibility/status/reasons/timestamps, regime restrictions and independent risk gate                          |
| News                 | Upstox, optional official RSS/GNews/NewsAPI, deduplication/clustering, source attribution, FinBERT HTTP integration, schema-validated extractive Ollama/Qwen briefing                   |
| Outcomes             | Candidate-time selected-option target-before-stop evidence, explicit entry/fill/ambiguity/gaps/invalidation and retained original signals                                               |
| Validation           | Actual offline LightGBM pipeline: chronological splits, purging/embargo, development-only tuning, separate calibration, unseen metrics, four ablations and permutation importance       |
| Storage              | Configurable market/news TTL, derivation before source expiry, restart compaction, incomplete-session retention, measured budget/growth/index/count health and optional-data throttling |
| Archive              | Read-only JSONL export plus compressed Parquet, source/readback SHA-256 verification and no exporter-driven MongoDB deletion                                                            |
| API/docs             | New features/decisions/briefings/outcomes/quality/validation/drift endpoints, expanded storage health, OpenAPI and setup documentation                                                  |

The 09:20 initial report, fifteen-minute reassessment, thirty-minute deep analysis, manual refresh, paper accounting and maximum five unique daily opportunities are preserved. Missing market data yields no trade or unavailable evidence. All ranking probabilities remain null.

## Verification

Local environment: Windows, Node.js **24.11.1**, portable Python **3.13.17**, temporary MongoDB **8.0.12** replica set. No live broker credentials or transformer model weights were used.

Final local verification results:

| Check                      | Result                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`            | Strict typecheck, lint, **101 tests across 7 files**, and production build passed                                                         |
| `npm run test:integration` | **6 tests passed** against a real temporary replica set, including actual TTL expiration and storage measurement                          |
| Python unittest            | **7 tests passed**, including actual LightGBM training, validation leakage test, Parquet round-trip/corruption and local service contract |
| Compiled smoke             | Passed readiness, authentication, synthetic report, explicit paper entry and OpenAPI                                                      |
| npm audit                  | **0 vulnerabilities** reported                                                                                                            |

Tests include no per-tick database writes, bounded/idempotent minute sampling, compaction before expiry, full-session aggregate/baseline preservation, incomplete-session protection, budget transitions, volume mathematics, cutoff/citation validation, strategy statuses, gap-aware option labels and existing risk/scheduler regressions. Changing unseen labels in the training test leaves hyperparameter selection and calibration unchanged. Python service tests mock sentiment inference; they do not claim FinBERT weights were downloaded or a real Qwen model was run.

One additional Mongo test launch exited with Windows process code 14 before any test ran; a diagnostic rerun passed all six tests and shut down the temporary replica set. The passing log is local at `.cache/mongo-check.log`.

Tests establish software behaviour, not forecast accuracy, profitable trading or broker-certified throughput. The existing CPU benchmark excludes database/network costs and is not a live capacity measurement.

## Required configuration and data boundaries

- Live operation requires the user's authorized Upstox token, MongoDB replica set, current cost assumptions and maintained event-calendar coverage in `.env`. Missing keys remain empty; none were invented.
- GNews, NewsAPI, official RSS and local inference are disabled until configured. The optional Python worker and Ollama require their runtimes/models. The news worker starts before 09:00, but late startup or an outage can miss the deadline; actual availability is retained.
- Briefing events are exact source excerpts with verified references. Official attribution does not independently prove a claim. Name-based mapping and headline clustering cannot establish exhaustive company/event coverage.
- Index spot volume, authoritative sector mappings, full global macro coverage and exact OI exchange-update times are unavailable unless a suitable source supplies them. Futures confirmation is unavailable when comparable observations are missing.
- Candle VWAP and rolling-window OBV/ADL have documented approximation/rebasing semantics. Sampled option OHLC is not exchange OHLC. No participant intent is inferred from CE/PE activity or OI alone.
- One-minute snapshots save storage but cannot prove every stop/target sequence. Restarts can lose live-only outcome evidence; research/replay then returns unavailable rather than reconstructing fictitious ticks. Expired detailed quotes cannot be regenerated from compact aggregates.
- Original audit records do not expire. Incomplete minute sessions remain stored until derivation is verified. Optional-data throttling is not a hard disk quota, and untouched legacy aggregate/profile/news records may need a separate reviewed migration. Follow storage health and use verified archival exports where appropriate.
- Training requires at least 300 usable option outcomes; no trained market model, calibrated live probability or performance improvement is claimed. Exports are bounded and use retained candidate features; unavailable premium-path, sector and broader history features remain missing. Imported reports never approve serving.
- Replay is one underlying/contract at a time and requires point-in-time metadata, receipt-valid bars and recorded depth. A portfolio optimizer, licensed expired-history importer and exercise/settlement simulator are not supplied.
- Deploy one Node process initially. Feed ownership, rate limits and local workers are process-local. TLS, production database credentials, backups and operational acceptance remain deployment tasks.

Use `npm run demo` for the offline backend. Local login details remain in `.env`. See [README](README.md), [API contract](API_CONTRACT.md), [advanced setup/storage/model/archive guide](docs/ADVANCED_RESEARCH.md) and [pre-change storage audit](docs/STORAGE_AUDIT.md).
