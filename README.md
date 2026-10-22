# Stockss — Indian F&O research backend

A standalone Node.js / Express / TypeScript backend for market-data collection, volume-first research, paper trading and historical replay. MongoDB is the only persistent database. There is no broker order submission code.

The default demo runs without MongoDB, broker access, Python or internet after dependencies have been installed. It uses an ephemeral fixture cache, fictional `DEMO|...` instruments and a fixed **21 October 2026, 09:20:02 IST** clock. Its example opportunity is synthetic, not a market recommendation. Restarting the memory demo resets its data.

## Quick start

Use Node.js **24 LTS** and npm. From this directory:

```sh
npm ci
npm run setup
npm run demo
```

The server listens at `http://127.0.0.1:3000`. This project exposes a REST API; it does not serve a frontend. `GET /healthz` and `GET /readyz` work without authentication.

`npm run setup` creates `.env`, generates a random login password and JWT signing key, and preserves existing nonempty configuration. Read `APP_USERNAME` and `APP_INITIAL_PASSWORD` in your local `.env` to log in. The server verifies `APP_PASSWORD_HASH`; it never returns secrets through the API. Secrets are excluded by `.gitignore` and `.dockerignore`. Keep `.env` accessible only to your server account. `APP_INITIAL_PASSWORD` is a local recovery convenience and can be removed after storing the password securely.

Login request:

```http
POST /api/v1/auth/login
Content-Type: application/json

{"username":"owner","password":"<APP_INITIAL_PASSWORD from your .env>"}
```

Use the returned `data.accessToken` as `Authorization: Bearer <token>`. Tokens expire after the configured duration; log in again. The bearer token should be stored in the mobile platform's secure credential storage.

Try these authenticated routes:

```text
GET /api/v1/analysis/latest
GET /api/v1/opportunities
GET /api/v1/market/volume?instrumentKey=DEMO%7CACME
GET /api/v1/market/option-chain?instrumentKey=DEMO%7CACME
GET /api/v1/performance
GET /api/v1/openapi.json
```

To paper-trade an opportunity, explicitly submit its ID. Merely publishing, viewing or triggering a research scenario does not execute a paper trade:

```http
POST /api/v1/paper-trades
Authorization: Bearer <token>
Idempotency-Key: my-paper-entry-001
Content-Type: application/json

{"signalId":"<opportunity id>","lots":1}
```

`POST /api/v1/paper-trades/<trade-id>/close` with `{}` simulates a manual exit using a fresh bid. Paper positions otherwise monitor stop, second target and session close. Target 1 is recorded in the research lifecycle; the initial paper policy exits the entire position at target 2, stop or close. Stale quotes or inadequate depth produce `NO_FILL`, not an invented execution. The frozen demo supports explicit entry and close; it does not simulate a moving exchange.

## Project layout

```text
src/
  api/          Express routes, auth, Zod request contracts, OpenAPI generator
  db/           Mongoose collections/indexes, transactional Mongo store, demo cache
  engines/      Volume, indicators, strategies, scenarios, risk, replay metrics
  market/       IST/session time, cumulative-volume tracking, candle aggregation
  providers/    Read-only Upstox REST and V3 Protobuf WebSocket
  services/     Collection, news/events, analysis, scheduler, paper accounting, ML seam
  testing/      Clearly labelled deterministic demo fixture
  config.ts     Validated environment configuration
  server.ts     Startup, composition and graceful shutdown
proto/          Official Upstox V3 schema and provenance
scripts/        Secret setup, demo, development watcher, docs, benchmark
tests/          Unit, API, replay and real MongoDB integration tests
```

## Enable authorized live data

1. Provide your own MongoDB replica set. A single-node replica set is sufficient for development. For a local Docker installation, `docker compose -f docker-compose.dev.yml up -d` starts one bound to loopback. This development MongoDB configuration has no authentication and must not be exposed publicly.
2. Use a separate database for live data. The backend refuses to reuse a database marked for the other mode.
3. Set `.env` values: `DATA_MODE=live`, `STORAGE_MODE=mongo`, a valid `MONGODB_URI`, and your authorized `UPSTOX_ANALYTICS_TOKEN`. No trading API key, trading secret, order endpoint or OAuth trading flow is required by this app.
4. Choose `UPSTOX_UNDERLYING_KEYS`. The default watchlist is Nifty 50 and Nifty Bank. Stock keys can be added. Empty configuration selects a deterministic bounded universe from currently listed F&O underlyings; it is not a claim that the chosen symbols are the most liquid. `MAX_UNDERLYINGS` and `MAX_SUBSCRIPTIONS` bound collection.
5. Review the simulated cost rates in `.env` against your current applicable costs, then set `COSTS_VERIFIED=true`. Supplied rates are estimates, not verified statutory advice. Unverified costs block live research admission.
6. Supply a maintained event calendar file via `EVENT_CALENDAR_PATH` (schema below). `REQUIRE_EVENT_CALENDAR=true` blocks live admissions when calendar coverage is missing. This explicit coverage requirement is separate from automatic exchange-session retrieval.
7. Run `npm run build` and `npm start`, or `npm run dev` to rebuild/restart after source changes. `npm run demo` explicitly overrides live settings for that process and always uses the memory fixture cache.

No live prices are fetched in demo mode. Live API failures never fall back to synthetic values. Initial historical retrieval can take several minutes and broker entitlement or retention limits may leave baselines unavailable. Start before 08:45 IST and inspect `/api/v1/system/health`.

Example **schema only** for a local reviewed event calendar:

```json
{
  "validFrom": "2026-10-21",
  "validUntil": "2026-10-21",
  "source": "Your reviewed official calendar source and review date",
  "events": [
    {
      "id": "example-event-do-not-use-as-real-data",
      "title": "Illustrative event only",
      "start": 1792556400000,
      "end": 1792560000000,
      "instrumentKeys": [],
      "impact": "HIGH",
      "publishedAt": 1792500000000
    }
  ]
}
```

An empty `instrumentKeys` list means market-wide. The example is not an actual economic event. The file must reflect your reviewed event coverage, including earnings, and be refreshed before `validUntil`. `RSS_FEED_URLS` accepts comma-separated permitted HTTPS feeds. Upstox instrument news is collected automatically in live mode. No unofficial scraping is used.

## Schedule and research behaviour

Normal NSE derivatives sessions use 08:45 preparation, 09:00 premarket context, the completed 09:15–09:20 opening window, and the first report at **09:20 or after required data arrives**. Evaluations follow at 09:35, 09:50, 10:05, 10:20, etc.; every second follow-up is marked `DEEP`. Deep evaluations currently reuse the full feature/regime pipeline, which is also recomputed on regular evaluations. There is no separate validated ML regime model.

Exchange timings come from the official NFO session endpoint. Holidays are closed sessions; special sessions shift the schedule relative to the verified opening time. Jobs have persistent IDs, leases, retry checkpoints and restart recovery. Missed intermediate evaluations are skipped rather than reconstructed using today's later information. An overdue initial report records its actual analysis time. Missing opening data produces `INSUFFICIENT_DATA` and can trigger a later initial attempt; every published attempt remains immutable.

Volume and executable option liquidity are eligibility gates. The engine evaluates the underlying before mapped CE/PE contracts. Index volume uses an explicitly identified listed futures proxy; index spot never receives synthetic traded volume. One daily slot is consumed per accepted underlying, with a hard ceiling of five unique signals. Refreshing does not reset the cap.

Premium levels use underlying opening structure mapped through local delta/gamma and a short theta stress, with tick rounding and conservative spread/slippage. This is an **unvalidated research approximation**, not a guaranteed option-price projection. A missing Greek or unsuitable structure rejects the scenario. All ranking probabilities remain `null` in the shipped research strategy.

## Configuration and security

`.env.example` lists all keys, thresholds and defaults. Environment variables override `.env`. The principal groups are:

| Configuration                                                     | Purpose                                                   |
| ----------------------------------------------------------------- | --------------------------------------------------------- |
| `APP_USERNAME`, `APP_PASSWORD_HASH`, `JWT_SECRET`                 | Single-user login and bearer signing                      |
| `MONGODB_URI`, `DATA_MODE`, `STORAGE_MODE`                        | Persistent database and strict demo/live separation       |
| `UPSTOX_ANALYTICS_TOKEN`                                          | Authorized market-data access; never logged               |
| `HOST`, `PORT`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS`                | Server/network configuration                              |
| `BASELINE_*`, `MIN_RVOL`, `MIN_OPTION_VOLUME`, `MAX_SPREAD_PCT`   | Volume and liquidity gates                                |
| `SIMULATED_CAPITAL`, `MAX_*RISK`, `MAX_DAILY_LOSS`                | Independent capital/risk budgets                          |
| `GLOBAL_NO_TRADE`                                                 | Environment kill switch that API settings cannot override |
| `*_RATE`, `BROKERAGE_PER_ORDER`, `SLIPPAGE_BPS`, `COSTS_VERIFIED` | Explicit cost assumptions                                 |
| `EVENT_CALENDAR_PATH`, `REQUIRE_EVENT_CALENDAR`, `RSS_FEED_URLS`  | Event/news availability and restrictions                  |
| `FINBERT_URL`, `ML_INFERENCE_URL`                                 | Optional inference interfaces, disabled by default        |

The API uses strict input validation, request limits, Helmet, allowlisted CORS, rate limits and sanitized errors. Logging omits request bodies, credentials and broker response bodies. Use HTTPS at your reverse proxy for a remotely accessed deployment and configure only the actual trusted proxy hop count. Rate limits are process-local; this release is intended for one service process. Database transactions and unique indexes additionally protect concurrent requests and overlapping job attempts.

Do not put MongoDB credentials, broker tokens, passwords or private keys in source files. Back up MongoDB independently and test restoring it. Original signal records are append-only through the application and have integrity hashes; this does not make them tamper-proof against a database administrator.

## Commands and validation

```sh
npm run check                # strict typecheck, lint, unit/API tests, production build
npm run test:integration     # actual temporary MongoDB replica set
npm run test:smoke           # compiled server, HTTP login/report and paper entry
npm run test:performance     # synthetic volume CPU benchmark, not broker throughput
npm run docs                 # regenerate openapi.json
npm run format
```

The first integration-test run downloads a platform-specific MongoDB test binary to `.cache/mongodb`; on Windows it is large. It is separate from the offline demo and is cached for later tests. No real broker credential is used in tests. See `IMPLEMENTATION_STATUS.md` for actual verification results and limitations.

Backtests replay stored, time-stamped underlying candles and actual recorded option quote depth using the same strategy and risk modules. Both candle close and retrieval time must precede a decision. Missing point-in-time metadata, expired premiums, Greeks or executable spreads result in explicit insufficient data. Downloading today's historical OHLC does not fabricate a historical executable quote. The first release supports one underlying/contract per replay, a volume-free baseline comparison and regime-tagged outcomes, not a full portfolio optimizer or trained ML pipeline.

Allow at least 15–30 forward-test trading sessions, then perform additional chronological validation. Passing tests verifies software behaviour; it does not establish trading accuracy or profitability.

See [ARCHITECTURE.md](ARCHITECTURE.md), [API_CONTRACT.md](API_CONTRACT.md), [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) and [Upstox contract verification](docs/UPSTOX_API_VERIFICATION.md).
