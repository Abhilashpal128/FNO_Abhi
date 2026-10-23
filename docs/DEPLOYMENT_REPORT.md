# Deployment verification — 23 October 2026

**Project configuration is prepared for the existing Vercel project `fno-abhi`. Deployment is awaiting Vercel account authorization.** The local MongoDB URI was corrected by URL-encoding a reserved credential character, and a subsequent read-only Atlas connection/ping succeeded. No cloud deployment has been performed yet. Use [the deployment steps and exact API paths](VERCEL_DEPLOYMENT.md).

The real provider probe ran at approximately **06:47 IST on 23 October 2026**. Its sanitized output is `artifacts/preflight-2026-10-23.json`; credentials and authorized WebSocket URLs are excluded.

| Essential component                                   | Status  | Evidence / remaining work                                                                                                                                        |
| ----------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node build and API                                    | READY   | `npm ci` completed; strict typecheck, lint, 113 tests and production build passed                                                                                |
| Vercel configuration                                  | READY   | Native Express `app.ts`, Node 24.x, `vercel.json` validated against Vercel's published schema, secrets excluded from upload                                      |
| AI-disabled startup                                   | READY   | Master/per-model switches enforced, configured URLs cannot bypass them; no Python/model dependency in Node startup                                               |
| Owner authentication and API compatibility            | READY   | Auth-before-provider-work, startup retry/redaction, response schemas and compiled smoke checks passed                                                            |
| Read-only Upstox authentication                       | READY   | Actual V3 quote request succeeded; real null index volume/OI fields now parse correctly                                                                          |
| October 23 NFO calendar                               | READY   | Provider reports trading session 09:15–15:30 IST                                                                                                                 |
| Instruments                                           | READY   | 49,628 normalized master records; configured NIFTY/BANK NIFTY keys found                                                                                         |
| Historical price/volume data                          | READY   | 12,375 index minute candles each; 12,705/12,704 futures-proxy minute candles across 33 observed sessions; metric-specific coverage remains checked by the engine |
| Option chains                                         | READY   | Actual 27 October expiry returned 288 NIFTY and 314 BANK NIFTY option quotes                                                                                     |
| V3 WebSocket transport/decoding                       | READY   | Read-only local probe connected, decoded two frames and four quotes for four subscriptions; continuous streaming is not enabled in the Vercel Function           |
| MongoDB production connectivity                       | READY   | Corrected local URI passes parsing and an authenticated Atlas ping; select an explicit live database and verify indexes during deployment                         |
| MongoDB implementation                                | READY   | Seven temporary replica-set integration tests passed, including live runtime initialization, transactions, indexes, TTL and audit preservation                   |
| News provider connectivity                            | READY   | Upstox News, GNews and NewsAPI responded successfully                                                                                                            |
| News content / digest coverage                        | BLOCKED | Current queries returned zero articles. NSE/RBI RSS URLs are unconfigured. Configure permitted feeds/query coverage and collect sources before the digest cutoff |
| Reviewed event-risk coverage                          | BLOCKED | No usable reviewed calendar loaded; set `EVENT_CALENDAR_JSON` or the existing file setting                                                                       |
| Simulated costs                                       | BLOCKED | `COSTS_VERIFIED=false`; review applicable assumptions before enabling research admissions                                                                        |
| Live report persistence                               | BLOCKED | Cloud runtime and live database indexes still require deployment verification; no live opening report has been fabricated                                        |
| Automatic market-hour collection/monitoring on Vercel | BLOCKED | This configuration is request-driven. No continuous worker or scheduled cloud job was deployed                                                                   |
| Published Vercel URL                                  | BLOCKED | Existing project `fno-abhi` selected; Vercel account authorization pending                                                                                         |

Live probes establish access at the recorded time, not fresh market-hour prices or uninterrupted service. The history probe is read-only and does not preload production MongoDB. It observed about 409 MiB peak local RSS, which is a probe measurement rather than a production memory guarantee. Selected equities have not been added to the current two-index watchlist.

## Before using the market report

1. Authorize access to `fno-abhi`, configure the corrected MongoDB URI with an explicit live database and the documented environment variables, deploy, then verify `/readyz` and authenticated `/api/v1/system/health`.
2. Keep all four AI switches false. Supply any permitted news feeds and reviewed event/cost settings you actually have; missing data must remain explicit.
3. Use authenticated market/candle requests and `POST /api/v1/analysis/refresh` to collect and evaluate available real data. This generates a manual report and may legitimately yield `NO_TRADE` or `INSUFFICIENT_DATA`.
4. If unattended 09:00/09:20 and every-15/30-minute execution or continuous paper monitoring is required, the existing persistent worker must also be operated. A manual Vercel API deployment alone does not provide those guarantees.

Build: `npm run build`. Vercel entry: root `app.ts` (no Start Command override). Persistent/local start: `npm start`. Full environment names, frontend setup and route examples are in [VERCEL_DEPLOYMENT.md](VERCEL_DEPLOYMENT.md).

Local checks: 113 Node tests, seven MongoDB integration tests, seven optional Python tests and compiled smoke passed. The Python tests preserve the disabled integrations; no transformer weights or real inference were used. Initial MongoDB integration starts failed because the system temporary drive was full; running the isolated test in `D:\StockssApp\.cache\test-tmp` passed all seven tests without altering production data.
