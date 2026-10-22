# Implementation status

Updated **22 October 2026**. The backend implementation and local verification are complete for the initial research release. Live broker operation and strategy accuracy have not been validated. No real orders are implemented.

## Delivered

| Area                      | Implemented behaviour                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application and security  | Strict TypeScript, Express, validated `.env`, single-owner scrypt/JWT authentication, rate limits, safe errors, Pino redaction and health endpoints                                                                  |
| Persistence               | MongoDB/Mongoose schemas and indexes, replica-set transactions, idempotent accounting, append-only original signals/events, metadata/calendar versions and quote retention                                           |
| Market data               | Official Upstox REST adapters, instrument master, quotes, option chains, news, NFO session calendar, V3 protobuf socket, bounded subscriptions, retries and reconciliation                                           |
| Candles and volume        | Completed 1/5/15/30-minute aggregation, conservative daily finalization, cumulative-volume corrections/resets, same-time RVOL, volume gates, VWAP and derivative/liquidity features                                  |
| Research                  | Technical indicators, regime selection, versioned underlying-first strategy, actual contract metadata, Greek-based premium scenarios, volume-first ranking and immutable decision snapshots                          |
| Risk and scheduling       | Independent capital/loss/liquidity/expiry/event gates, global no-trade switch, maximum five unique daily opportunities, 09:20 initial report, 15-minute follow-ups, 30-minute deep evaluations and restart-safe jobs |
| Paper trading             | Explicit idempotent entries, lot/depth checks, ask/bid fills with fees/slippage, stop/target monitoring, cash accounting and realized/unrealized performance                                                         |
| Historical replay         | Received-time cutoffs, metadata/calendar versions, recorded executable quotes, common strategy/risk modules, baseline comparison and explicit missing/unresolved outcomes                                            |
| API and delivery          | Authenticated route groups, Zod validation, OpenAPI 3.1, offline synthetic demo, local scripts, Dockerfile and development MongoDB replica-set compose file                                                          |
| Optional model boundaries | FinBERT sentiment HTTP adapter and a validation-gated model inference interface; unavailable probabilities/sentiment remain null                                                                                     |

## Verification actually run

Environment: Windows, Node.js **24.11.1**. No live broker credentials were used.

| Check                                | Observed result                                                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                      | Strict typecheck, lint, **73 tests across 6 files**, and production build passed                                                                                      |
| `npm run test:integration`           | **4 tests passed** against an actual temporary MongoDB 8.0.12 replica set                                                                                             |
| `node scripts/smoke.mjs` after build | Compiled server readiness, unauthenticated denial, login, synthetic initial report, paper entry and OpenAPI retrieval passed; isolated child server stopped afterward |
| `node dist/scripts/openapi.js`       | Generated `openapi.json` successfully                                                                                                                                 |
| `npm audit --audit-level=high`       | **0 vulnerabilities** reported                                                                                                                                        |
| `node dist/scripts/benchmark.js`     | **100,000 synthetic observations in 1,332 ms**, approximately 75,086 observations/second; database and network excluded                                               |

Regression coverage includes duplicate live/historical candles, first-receipt preservation, correction timing, invalidated volume baselines, cross-minute uncertainty after flush, official-OHLC precedence, daily completion, malformed expiry/lot/strike metadata, calendar removals and replay end-time boundaries. MongoDB tests exercise concurrent signal/paper admission, rollback, append-only restrictions, unique indexes and bulk writes across a 1,000-record batch boundary. API tests validate actual responses against the generated response schemas.

The benchmark measures a CPU calculation only. These tests establish software behaviour, not trading profitability, forecast accuracy or production broker throughput.

## Required before live operation

1. Configure an authorized `UPSTOX_ANALYTICS_TOKEN`, `DATA_MODE=live`, `STORAGE_MODE=mongo` and a MongoDB replica-set URI in `.env`.
2. Review your actual cost assumptions before setting `COSTS_VERIFIED=true`; maintain the reviewed economic/company calendar specified by `EVENT_CALENDAR_PATH`.
3. Verify real account entitlement, instrument tick/lot metadata, quote units and freshness, WebSocket delivery, holiday/special-session timings and collection capacity. See [official contract verification](docs/UPSTOX_API_VERIFICATION.md).
4. Collect sufficient historical baselines and point-in-time option observations. Start before preparation time and check authenticated system health. Missing data returns `INSUFFICIENT_DATA` or `NO_TRADE`.
5. Forward-test for at least 15–30 trading sessions and perform additional chronological validation before considering the research evidence meaningful.

## Explicit boundaries

- The opening-participation strategy, thresholds and Greek premium approximation are unvalidated research hypotheses. Probabilities are null; no trained LightGBM/FinBERT service, training pipeline, calibration evidence or successful market performance is supplied.
- Backtests replay one underlying/contract from recorded observations. They cannot manufacture expired-option depth or Greeks from historical OHLC. A general licensed expired-history importer and portfolio-level simulator are outside this initial release.
- Candles are correctable records. Identical downloads preserve original availability, while corrections get a later timestamp. Replacing a historical revision can make earlier replay insufficient; original published signal snapshots stay immutable.
- News uses configured permitted feeds and the first page of recent Upstox instrument news. This is not a complete historical archive or automatic complete earnings calendar. FinBERT is optional; sector-relative strength and licensed global macro coverage are unavailable without suitable sources.
- Deep evaluations recompute the full existing feature/regime pipeline; there is no separate validated ML regime model. Unknown OI update times and uncertain participant intent remain explicit.
- Quotes are sampled into storage at most once per instrument per second. This supports the documented recorded-quote replay, not exchange tick-perfect execution. Locally sampled candle OHLC cannot qualify research until valid source OHLC arrives.
- Unfillable paper exits remain unresolved open positions. Stops and estimated loss are not guarantees. A replay with an unresolved exit stops further entries.
- Use one application process initially. MongoDB handles concurrent admissions, but feed ownership, request pacing and API rate limits are process-local. Deployment, TLS, backups, production database authentication and live operational acceptance remain the operator's responsibility.

Run `npm run demo` for the offline backend. Local login details are in `.env`; [README.md](README.md) documents setup and API use.
