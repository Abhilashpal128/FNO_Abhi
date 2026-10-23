# Implementation status

Updated **23 October 2026**. Vercel project configuration and an authenticated, request-driven API entry point are complete. All LLM/model execution defaults to **DISABLED**; news and market APIs remain active. Read-only Upstox authentication/history/chain/WebSocket probes passed. The local MongoDB URI was corrected and an authenticated Atlas ping now passes. Deployment to the existing `fno-abhi` Vercel project awaits account authorization; cloud persistence is not yet verified. Trading accuracy has not been validated. No real order execution is implemented.

See [Vercel deployment instructions](docs/VERCEL_DEPLOYMENT.md) and the [READY/BLOCKED verification report](docs/DEPLOYMENT_REPORT.md). No Vercel deployment has been performed yet.

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

The persistent worker preserves the 09:20 initial report, fifteen-minute reassessment and thirty-minute deep analysis. Vercel performs collection/evaluation within requests and does not start the scheduler or feed. Existing algorithms, risk controls, manual refresh, paper accounting and maximum five unique daily opportunities remain. New signals explicitly identify `INTRADAY`; no swing strategy was invented. Daily paper metrics count completed trades by IST exit date separately from raw-signal outcomes. All ranking probabilities remain null.

## Verification

Local environment: Windows, Node.js **24.11.1**, portable Python **3.13.17**, temporary MongoDB **8.0.12** replica set. Authorized credentials were used only for read-only live provider probes. No transformer model weights or real inference were used.

Final local verification results:

| Check                      | Result                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`            | Strict typecheck, lint, **113 tests across 9 files**, and production build passed                                                         |
| `npm run test:integration` | **7 tests passed** against a real temporary replica set, including actual TTL expiration and storage measurement                          |
| Python unittest            | **7 tests passed**, including actual LightGBM training, validation leakage test, Parquet round-trip/corruption and local service contract |
| Compiled smoke             | Passed readiness, authentication, synthetic report, explicit paper entry and OpenAPI                                                      |
| npm audit                  | **0 vulnerabilities** reported                                                                                                            |

Tests include no per-tick database writes, bounded/idempotent minute sampling, compaction before expiry, full-session aggregate/baseline preservation, incomplete-session protection, budget transitions, volume mathematics, cutoff/citation validation, strategy statuses, gap-aware option labels and existing risk/scheduler regressions. Changing unseen labels in the training test leaves hyperparameter selection and calibration unchanged. Python service tests mock sentiment inference; they do not claim FinBERT weights were downloaded or a real Qwen model was run.

The current MongoDB integration run passed all seven tests using a workspace temporary directory. Initial attempts failed because the system temporary drive was full; no production database was changed. Current passing logs are `.cache/deployment-check.log`, `.cache/deployment-integration.log`, `.cache/deployment-smoke.log` and `.cache/deployment-python.log`.

Tests establish software behaviour, not forecast accuracy, profitable trading or broker-certified throughput. The existing CPU benchmark excludes database/network costs and is not a live capacity measurement.

## Required configuration and data boundaries

- Live operation requires the user's authorized Upstox token, MongoDB replica set, current cost assumptions and maintained event-calendar coverage in `.env`. Missing keys remain empty; none were invented.
- News APIs run independently of AI. Current Upstox/GNews/NewsAPI connectivity checks passed but returned zero articles; official NSE/RBI feeds remain unconfigured. Model URLs alone cannot enable inference: the global flag and individual model flag must both be true. The Node deployment does not need Python or Ollama. A 09:00 source digest requires actual pre-cutoff receipts; Vercel only processes it when requested.
- Briefing events are exact source excerpts with verified references. Official attribution does not independently prove a claim. Name-based mapping and headline clustering cannot establish exhaustive company/event coverage.
- Index spot volume, authoritative sector mappings, full global macro coverage and exact OI exchange-update times are unavailable unless a suitable source supplies them. Futures confirmation is unavailable when comparable observations are missing.
- Candle VWAP and rolling-window OBV/ADL have documented approximation/rebasing semantics. Sampled option OHLC is not exchange OHLC. No participant intent is inferred from CE/PE activity or OI alone.
- One-minute snapshots save storage but cannot prove every stop/target sequence. Restarts can lose live-only outcome evidence; research/replay then returns unavailable rather than reconstructing fictitious ticks. Expired detailed quotes cannot be regenerated from compact aggregates.
- Original audit records do not expire. Incomplete minute sessions remain stored until derivation is verified. Optional-data throttling is not a hard disk quota, and untouched legacy aggregate/profile/news records may need a separate reviewed migration. Follow storage health and use verified archival exports where appropriate.
- Training requires at least 300 usable option outcomes; no trained market model, calibrated live probability or performance improvement is claimed. Exports are bounded and use retained candidate features; unavailable premium-path, sector and broader history features remain missing. Imported reports never approve serving.
- Replay is one underlying/contract at a time and requires point-in-time metadata, receipt-valid bars and recorded depth. A portfolio optimizer, licensed expired-history importer and exercise/settlement simulator are not supplied.
- Vercel initializes one cached Mongo pool per warm Function instance and performs data work only after API authentication. The persistent worker should run as one process if used separately; its feed ownership and local workers remain process-local. Rate limits also remain instance-local. Production credentials, network access and cloud verification remain deployment tasks.

Use `npm run demo` for the offline backend. Local login details remain in `.env`. See [README](README.md), [API contract](API_CONTRACT.md), [advanced setup/storage/model/archive guide](docs/ADVANCED_RESEARCH.md) and [pre-change storage audit](docs/STORAGE_AUDIT.md).
