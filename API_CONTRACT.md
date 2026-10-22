# API contract

Base path: `/api/v1`. JSON request/response bodies, bearer authentication except login, and a single configured owner account. The authoritative machine-readable contract is [openapi.json](openapi.json), regenerated with `npm run docs` from the route catalog, Zod requests and response schemas.

Success envelope:

```json
{
  "data": {},
  "meta": {
    "mode": "demo",
    "serverTime": "2026-10-21T04:00:00.000Z",
    "analysisClock": "2026-10-21T03:50:02.000Z",
    "synthetic": true
  }
}
```

`data` can be an object, array or documented nullable value. `serverTime` is wall-clock UTC; demo `analysisClock` is frozen and deliberately different. Domain timestamps are UTC epoch milliseconds, prices are INR per unit, and contract quantities use the listed lot size. Date-only expiry values use the exchange calendar. Unknown measurements are `null`, not zero.

Error envelope:

```json
{ "error": { "code": "RISK_REJECTED", "message": "RISK_REJECTED", "reasons": ["TRADE_RISK_BUDGET"] } }
```

Validation errors include field paths and messages, without echoing submitted values or credentials. Status codes: 400 validation, 401 authentication, 404 missing record, 409 rejected/conflicting operation or no fill, 413 oversized body, 422 unavailable replay mapping/range, 429 rate limit, 500 internal failure. `/readyz` may return 503 for database unavailability. Bodies are capped at 64 KB.

| Method | Path                        | Behaviour                                                                                             |
| ------ | --------------------------- | ----------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login`               | `username`, `password`; returns token and expiry                                                      |
| GET    | `/auth/me`                  | Owner identity                                                                                        |
| GET    | `/market`                   | Session, selected underlyings, volume proxies, latest quotes and feed status                          |
| GET    | `/market/candles`           | `instrumentKey`, optional `interval=1/5/15/30/1440`, `from`, `to`, `limit≤1000`; newest first         |
| GET    | `/market/volume`            | `instrumentKey`; opening/current features and 1/5/15/30-minute/daily volume details                   |
| GET    | `/market/option-chain`      | Underlying `instrumentKey`, optional ISO `expiry`; stored listed contracts and collected quote subset |
| GET    | `/market/regime`            | Recent underlying regimes and technical features                                                      |
| GET    | `/news`                     | Collected known-at-time news; optional `before`, `limit≤100`                                          |
| GET    | `/analysis/latest`          | `{latest, initial}`; each nullable before its first report                                            |
| GET    | `/analysis/history`         | Immutable runs; optional `before`, `limit≤100`                                                        |
| POST   | `/analysis/refresh`         | `{}`; evaluates currently collected data with the same risk gates                                     |
| GET    | `/opportunities`            | Up to five original daily snapshots with current lifecycle status                                     |
| GET    | `/opportunities/:id`        | Original snapshot, integrity hash and current status                                                  |
| GET    | `/opportunities/:id/events` | Append-only chronological lifecycle events                                                            |
| GET    | `/strategies`               | Versions, compatible regimes and validation status                                                    |
| GET    | `/paper-trades`             | Most recent simulated trades                                                                          |
| POST   | `/paper-trades`             | `signalId`, positive integer `lots`, required `Idempotency-Key`                                       |
| POST   | `/paper-trades/:id/close`   | `{}`; observed bid exit or explicit `NO_FILL`                                                         |
| GET    | `/backtests`                | Stored runs; optional `before`, `limit≤100`                                                           |
| POST   | `/backtests`                | `underlyingKey`, `contractKey`, epoch-ms `from`, `to`; ≤90 days, no future dates                      |
| GET    | `/backtests/:id`            | Trades, cost-adjusted metrics, baseline and limitations                                               |
| GET    | `/performance`              | Account, realized metrics, open marks and forward-session count                                       |
| GET    | `/settings`                 | Risk limits and verification flags; no secrets                                                        |
| PATCH  | `/settings`                 | Only documented risk fields; maximum daily opportunities cannot exceed five                           |
| GET    | `/system/health`            | Database, feed, session and component diagnostics                                                     |
| GET    | `/openapi.json`             | Authenticated OpenAPI document                                                                        |

Public `/healthz` and `/readyz` are outside `/api/v1`. Readiness means the service's data store is available; it does not mean market data is currently suitable for a signal. Check report status, quality limitations, freshness and active signal IDs.

Analysis reports contain ID, trading day, scheduled and actual analysis timestamps, `OPPORTUNITIES | NO_TRADE | INSUFFICIENT_DATA`, data mode/freshness, original daily signal IDs, active signal IDs, per-signal lifecycle/risk status, per-underlying volume analysis, rejection reasons and the next scheduled analysis time. A previous day's latest report keeps its original day and timestamps.

Opportunity snapshots include the actual underlying and contract metadata, quote provenance, strike/expiry/lot, entry range, stop and two targets, invalidation, validity end, premium capital, planned loss with costs, reward/risk, supporting/conflicting strategy information, volume, regime, news references and quality warnings. `probability=null` means no calibrated probability model exists. A technical feature or ranking value is never a win percentage.

Lifecycle values are `WATCHING`, `TRIGGERED`, `MONITORING`, `TARGET_1_HIT`, `TARGET_2_HIT`, `STOPPED`, `EXPIRED`, `INVALIDATED`, `REJECTED`, `DATA_UNAVAILABLE`. Triggering a research range does not imply execution. Research validity expiry does not silently close an independently opened paper position.

Paper idempotency keys are 8–128 alphanumeric, underscore or hyphen characters. Repeating the same key with the same payload returns the existing trade. Reusing it with different parameters is rejected. Exit requests return the already closed record if repeated. The application never sends the request to a brokerage order API.

Rate limits default to 120 requests/minute/IP, 10 login attempts/15 minutes/IP, and 2 manual analyses or replay requests/minute/IP for each route. They are process-local. Endpoint cursors (`before`) are timestamps; ordering ties can require a smaller time range. This is intended for a single personal client, not public bulk distribution of licensed market data.

## Advanced research endpoints

All paths below use the existing `/api/v1` prefix, bearer authentication and standard response envelope. Timestamps remain UTC epoch milliseconds.

| Method | Path                                            | Data                                                                             |
| ------ | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/market/features?instrumentKey=...`            | Latest advanced-volume feature record or null                                    |
| GET    | `/market/option-observations?instrumentKey=...` | Up to 100 completed five-minute sampled option summaries                         |
| GET    | `/strategies/decisions?instrumentKey=...`       | Last 50 assessment sets with per-strategy eligibility/reasons/version/as-of      |
| GET    | `/news/briefings/latest`                        | Most recent versioned briefing or null                                           |
| GET    | `/news/briefings?before=...&limit=20`           | Briefings paginated by creation time; limit at most 100                          |
| GET    | `/research/outcomes?before=...&limit=20`        | Immutable option outcomes paginated by candidate time                            |
| GET    | `/research/quality`                             | Label coverage, target-before-stop outcomes, realized costs and regime summaries |
| GET    | `/models/validation`                            | Last 20 imported validation reports, including unapproved evidence               |
| GET    | `/models/drift`                                 | Candidate RVOL PSI, sample counts and null unvalidated threshold                 |

`/market/volume` additionally returns `advanced`: volume moments/z-score/acceleration, rolling OBV/ADL, contiguous-session approximate VWAP, divergence, breakout/rejection and participation hypotheses. Quality fields explain unavailable baselines, sector peers or session prefixes.

`/system/health.data.storage` is nullable before the first check. It includes per-collection counts/data/storage/index bytes, measured total/budget/percentage, daily growth, estimated days to critical capacity, `NORMAL | WARNING | REDUCED | CRITICAL | UNAVAILABLE`, optional sampling stride and retention status. The memory demo reports unmeasured physical storage. The API never returns database credentials.

Strategy statuses are `ELIGIBLE | REJECTED | INSUFFICIENT_DATA | DATA_UNAVAILABLE`. Briefing statuses are `READY | DEGRADED | UNAVAILABLE`, with fixed source cutoff, actual creation time, retained source excerpts, clusters, cited extractive events and failure codes. `OFFICIAL_SOURCE` verifies source attribution, not every factual claim. Optional model failures never become invented summaries or neutral sentiment.

Outcome statuses are `TARGET_BEFORE_STOP | STOP_BEFORE_TARGET | NEITHER_HIT | AMBIGUOUS | INVALIDATED | DATA_UNAVAILABLE | ENTRY_NOT_REACHED`. Records preserve candidate/horizon/evaluation times, observed entry/target/stop times, paper-fill flag and observation-gap evidence. Sparse history cannot establish tick ordering and can remain unavailable. These records never update the original opportunity snapshot.

Backtests also expose `ablations` (without volume/news/both) and `evaluation` (decision/eligible/fill/no-fill/unresolved counts, costs, coverage and loss streak). Risk and execution requirements remain active during ablations. Empty or unavailable metrics are not proof that a feature helps or harms prediction. Validation reports retain chronological split, calibration, unseen-period and feature-importance evidence; importing one does not activate a model. Rule-based probabilities stay null.
