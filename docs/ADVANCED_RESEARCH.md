# Advanced research and low-cost storage

This update extends the existing Node/TypeScript backend. MongoDB remains the only database, and research signals remain separate from paper executions. No broker order client, notifications, or automatic model promotion is included.

## Collection and storage

The pre-change source audit is in [STORAGE_AUDIT.md](STORAGE_AUDIT.md). The current path maintains latest quotes, cumulative volume, the current candles, and a bounded completed-minute cache in memory. It processes feed updates continuously. It does not insert raw ticks into MongoDB. Session VWAP sums update incrementally on completed candle additions/corrections, with bounded history and explicit gap checks. Candle/history aggregation runs on completed observations, and strategy features are computed at analysis time rather than by rereading history for every tick.

The default universe is bounded by `MAX_UNDERLYINGS=12`; the explicit example watchlist has two indices. `MAX_NEARBY_OPTION_LEGS=8` selects nearby liquid legs per selected expiry, with at most two expiries. `MAX_SNAPSHOT_INSTRUMENTS=60` caps persisted derivative observations across the selected universe. Open paper contracts and index futures proxies take priority. Quote subscriptions and optional persistence have separate limits.

Selected derivative quotes are reduced to one terminal observation per completed source minute, with a deterministic instrument/minute ID. The original source and receipt timestamps are preserved. Retries/restarts cannot insert another record with that ID. A retransmitted newer observation for an already committed minute does not replace its original snapshot. Pending observations and version metadata are flushed in bounded batches. Five-minute summaries retain sampled price OHLC, last bid/ask, cumulative volume, observed volume change and OI change. Their quality fields explicitly distinguish sampled prices from exchange OHLC and observed volume change from complete interval volume.

An uninterrupted 375-minute session produces at most 375 detailed observations per continuously selected contract, compared with up to 22,500 under the old one-second policy. This is a record-count comparison, not a measured compression ratio or guaranteed database cost. Reconnects, source gaps, disabled snapshots and budget throttling reduce coverage. No complete broker payloads or article bodies are stored.

| Category                                                                                                              | Initial retention   | Before expiry                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Raw ticks                                                                                                             | Memory only         | Never inserted                                                                   |
| Selected one-minute candles                                                                                           | 60 days             | Complete session aggregates, daily candle and valid same-time baselines verified |
| Five/fifteen/thirty-minute candles                                                                                    | 365 days            | Available as compact historical records                                          |
| Daily candles                                                                                                         | 1,095 days          | Three-year default                                                               |
| Same-time volume profiles                                                                                             | 365 days            | Config must cover the baseline lookback                                          |
| Selected detailed option observations                                                                                 | 7 days              | Closed five-minute summary persisted                                             |
| Compact option observations                                                                                           | 90 days             | Quality flags retained                                                           |
| News metadata                                                                                                         | 180 days            | Briefing source excerpts and original signal news features retained separately   |
| Original signals, events, trades, executions, research outcomes, strategy decisions, briefings and validation reports | No automatic expiry | Permanent audit history                                                          |

These are ordinary MongoDB collections with unique logical keys where appropriate. TTL uses a separate single-field `Date` index with `expireAfterSeconds: 0`. Numeric domain timestamps are UTC milliseconds. Expiry is asynchronous; the configured retention is not an exact deletion deadline. Source minutes and detailed quotes have no TTL date until their derived records are verified. Incomplete sessions remain stored, appear in retention health, and are retried later so they cannot indefinitely prevent subsequent sessions from being processed. Data corrections can require re-verification.

On upgrade, the application suspends old per-second snapshot TTL dates once, then compacts and re-arms those source records through bounded maintenance. Existing aggregate/profile/news documents acquire their configured TTL when written by the new ingestion path; untouched legacy records can require an export and a separately reviewed retention migration. There is no blanket purge of existing data. Original audit records never receive an expiry date.

Storage health measures collection document counts, data bytes, allocated collection bytes, index bytes, total allocated bytes, daily growth and estimated days to the critical threshold. Growth estimates require measurements at least one hour apart and remain null without evidence. One measurement per IST day is updated, preserving earlier days. The memory demo explicitly reports `measured=false`.

| Budget used                                  | Behaviour                                                      |
| -------------------------------------------- | -------------------------------------------------------------- |
| Below 60%                                    | Normal selected minute observations                            |
| 60%                                          | Warning in authenticated health                                |
| 75%                                          | Optional detailed observations sampled once every five minutes |
| 90%, or unavailable live storage measurement | Optional detailed observations stop                            |

The collector still maintains current quotes and essential candle, signal, quality and paper records. This protects audit history; it does not impose a hard filesystem quota. Essential records can eventually exceed the configured budget. `STORAGE_BUDGET_MB` must reflect the actual database allocation, and the `/system/health` response should be reviewed. There are no notifications or automatic audit deletions.

## Volume and strategies

Existing opening and 1/5/15/30-minute RVOL use matching instrument, interval and IST minute across distinct valid prior sessions. Baselines exclude today's observations, future receipt times, invalid candles and incompatible data modes. Index spot never receives invented traded volume; an explicitly mapped listed futures proxy supplies traded-volume context.

`advancedVolume` adds population standard deviation, same-time standardized anomalies, successive volume-growth acceleration, rolling-window OBV/ADL, divergence, breakout/rejection, exhaustion and participation hypotheses. Zero variance, missing volume and unsuitable data produce null/unavailable values. VWAP is a candle typical-price approximation and requires a complete contiguous session prefix. Rolling OBV/ADL are rebased window measures, not lifetime totals. `VOLUME_LOOKBACK`, `VOLUME_ANOMALY_Z`, `BASELINE_*` and existing RVOL thresholds are configurable and unvalidated defaults.

Sector-relative participation requires at least three comparable peer RVOL values. The supplied Upstox master adapter does not supply a verified sector mapping, so live sector participation stays unavailable until an authorized mapping/peer dataset is integrated. Unknown OI update times remain unknown. High CE volume and increasing OI do not identify buyer/seller intent.

The existing opening-participation strategy and EMA baseline are preserved. Ten independently versioned strategies are registered:

1. `orb-rvol`: completed opening-range breakout and RVOL.
2. `vwap-continuation`: comparable traded-instrument VWAP retest with trend confirmation.
3. `volume-ema-trend`: EMA, price direction and volume agreement.
4. `volume-divergence-reversal`: divergence plus reversal candle and RSI context.
5. `breakout-failure`: range rejection with directional confirmation.
6. `rsi-bollinger-reversion`: band rejection in a sideways regime.
7. `atr-risk-filter`: volatility filter plus independent trend/volume confirmation.
8. `futures-price-volume-oi`: comparable observed futures changes.
9. `option-chain-participation`: timestamped derivative activity, OI, depth and spread.
10. `news-price-volume-response`: sourced official sentiment available before the subsequent confirmation candle.

Every evaluation records `ELIGIBLE`, `REJECTED`, `INSUFFICIENT_DATA` or `DATA_UNAVAILABLE`, timestamp, version and explanation. This does not imply every strategy has sufficient data or emits a trade. The existing strategy has priority when multiple compatible strategies qualify; there is no invented weighted probability. The independent risk gate still enforces executable quotes, actual listed lots/expiry, capital, aggregate risk, event coverage, costs and the five-opportunity daily ceiling.

## News and optional local models

Upstox news runs with authorized live data. Optional GNews, NewsAPI and permitted RSS adapters activate only when configured. Use `NSE_RSS_URL` and `RBI_RSS_URL` for actual RSS XML feeds obtained from the [NSE RSS page](https://www.nseindia.com/static/rss-feed) and [RBI RSS page](https://www.rbi.org.in/Scripts/rss.aspx). No guessed XML endpoints or scraping fallback are enabled. `GNEWS_API_KEY` and `NEWSAPI_KEY` stay in `.env`. These optional services can have provider-specific plan/usage restrictions.

Collection begins at 08:30 IST and runs every five minutes until 16:00. A background worker begins briefing inference before 09:00, allowing the configured timeout plus one worker tick. The report has a fixed 09:00 source cutoff and an actual creation timestamp. A late start or outage cannot guarantee delivery by 09:00 and is not backdated. An existing day's version is retained rather than rewritten with later news. Session-relative research scheduling remains separate, including special exchange sessions.

Stories are timestamp-validated, deduplicated by canonical URL and clustered by deterministic headline similarity. Company mapping uses known names; sector mapping is only available when authoritative metadata exists. Official-source verification means the retrieved source and linked article have permitted official HTTPS hosts. It is not independent proof of every claim. Cluster matches retain official references; the backend does not fabricate a disclosure for a secondary-source story.

FinBERT supplies sentiment; Ollama/Qwen supplies schema-constrained, extractive event summaries. Model output must cite supplied source IDs and exact excerpts. Unknown references, unsupported paraphrases, malformed JSON and timeouts leave the briefing degraded. Article content is untrusted data, with no model tool access or ability to issue orders. The briefing permanently retains the supplied headlines/excerpts so its sources remain inspectable after article metadata expires. Inference is an asynchronous worker outside feed processing; failures do not become fake neutral sentiment.

For Ollama, install/run it locally, pull a permitted model such as `qwen3:4b` or `qwen3:8b`, then set:

```dotenv
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b
```

For the optional Python worker, use a supported Python installation and a local virtual environment:

```sh
python -m venv .venv
# Windows: .venv\Scripts\python.exe; Unix: .venv/bin/python
.venv\Scripts\python.exe -m pip install -r python/requirements-models.txt
.venv\Scripts\python.exe -m uvicorn model_service:app --app-dir python --host 127.0.0.1 --port 8001
```

Set `FINBERT_ENABLED=true`, `FINBERT_MODEL=ProsusAI/finbert`, and `FINBERT_SERVICE_URL=http://127.0.0.1:8001/sentiment` in `.env`. The worker reads only its named settings and does not copy other `.env` secrets into its environment. First FinBERT startup downloads model weights; review the model's license and ensure sufficient disk/RAM. Neither Ollama nor FinBERT requires a local API key. Leave them disabled if not installed. Node's research probabilities remain null until a separately reviewed validated serving integration is enabled.

## Outcome labels, training and validation

The research label is `option-target2-before-stop-v1`: observed selected-contract target 2 before its stop during `OUTCOME_HORIZON_MINUTES`, starting at the actual candidate timestamp. Entry condition, paper fill, target, stop, neither, invalidation, ambiguous ordering and unavailable evidence remain distinct. Quotes before the candidate timestamp cannot label a later opportunity. A target seen before any observed entry does not become a successful trade. Observation gaps before the first outcome invalidate the label. A same-bar target/stop touch is ambiguous.

Minute snapshots and compact OHLC cannot reconstruct all tick ordering. Live outcome accumulators use observed executable quotes in memory; restart reconstruction often returns `DATA_UNAVAILABLE` because one-minute samples cannot establish fifteen-second continuity. The lower storage policy deliberately retains that uncertainty rather than manufacturing wins. Paper fills still use actual ask/bid observations with fees and slippage, and unfillable exits remain unresolved.

Training is explicitly offline:

```sh
# Create the artifacts directory first. Outputs must be new filenames/directories.
npm run export:training -- artifacts/option-outcomes.jsonl
python python/train.py artifacts/option-outcomes.jsonl artifacts/model-v1 --embargo-minutes 30
npm run import:validation -- artifacts/model-v1/metadata.json
```

Export requires the configured MongoDB replica set. It uses immutable candidate features and non-ambiguous selected-option outcomes. Missing historical news features are null; expired news records are not reinterpreted as "no news." Only actual closed paper trades supply cost observations. Their execution prices already include slippage, so the export does not deduct it twice. Only the first 100,000 chronological eligible outcomes are read; use a reviewed segmented export for a larger dataset.

The training script requires at least 300 usable outcomes. It uses a chronological development/unseen split, purged walk-forward tuning, a separate later calibration block, and embargo gaps. Hyperparameters see only training/validation blocks. Platt calibration is fitted only on its separate block. Completely unseen labels are used for final metrics and permutation importance, not tuning. It trains full, without-volume, without-news and without-both variants. Results include precision, coverage, target-label accuracy, observed gross/net P&L and costs, expectancy, drawdown, losing streak, calibration, feature importance and regime breakdowns. Baseline prevalence is reported; replay separately compares the existing EMA baseline. Rule ablations retain execution/risk constraints.

Artifacts contain a native LightGBM text model, metadata, dataset checksum and validation evidence. They are created with `validated=false` and `approvedForServing=false`; importing the report never promotes a model. The Python prediction endpoint refuses an unapproved/unvalidated bundle. The Node inference contract also requires explicit stored walk-forward/calibration validation. `ML_INFERENCE_URL` alone cannot activate a probability. Training on synthetic test fixtures proves the pipeline runs; it is not a trained market model or evidence of improvement.

The shipped export has recorded RVOL, acceleration, VWAP deviation, OBV, EMA/RSI/ATR/momentum, spread, moneyness, IV/Greeks, option volume/OI and retained news features. Full premium-path, verified sector, realized-volatility and broader macro features require additional point-in-time coverage. Drift currently reports PSI for rolling candidate RVOL, with no claimed validated alarm threshold. The API summaries are bounded; use retained records and offline exports for larger research.

Run deterministic Python verification without downloading transformer weights:

```sh
python -m pip install -r python/requirements-test.txt
python -m unittest discover -s python -p "test_*.py" -v
```

This workspace also contains a checksum-verified portable Python 3.13.17 under `.cache/python313` used for local testing; it is not committed or required for normal Node demo operation.

## Verified Parquet archive

Archive only older market datasets to your own server. This is a file export, not another database. Configure `MONGODB_URI`, create an `artifacts` directory, and run:

```sh
# UTC epoch milliseconds; the interval is [from, to).
npm run export:history -- market_candles 1792449000000 1792535400000 artifacts/candles.jsonl
python -m pip install -r python/requirements-archive.txt
python python/archive.py artifacts/candles.jsonl artifacts/candles.parquet
```

Allowed collections are `market_candles`, `market_volume_profiles`, `option_snapshots` and `option_aggregates`. Node streams bounded batches into JSONL and a SHA-256/count/units manifest. Python writes ZSTD Parquet with instrument, timestamp and the complete original JSON record. It verifies source checksum and count, reads Parquet back to reconstruct the original JSONL hash, then creates a `.verified.json` manifest including the Parquet checksum. Corrupt input leaves an unverified `.partial` file for inspection and never a completed archive. Existing destinations are not overwritten.

Neither exporter deletes MongoDB records. Configured TTL remains independent, so export before the retention window ends if long-term raw history is required. Back up and restore-test archives; an export is not a MongoDB audit-history backup.

## Contract references

Provider behavior was checked against [Upstox news](https://upstox.com/developer/api-documentation/get-news/), [Upstox V3 feed](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/), [Ollama chat](https://docs.ollama.com/api/chat), [NewsAPI Everything](https://newsapi.org/docs/endpoints/everything), [GNews search](https://docs.gnews.io/endpoints/search-endpoint), [MongoDB TTL](https://www.mongodb.com/docs/manual/core/index-ttl/), [FinBERT](https://huggingface.co/ProsusAI/finbert), [LightGBM Python API](https://lightgbm.readthedocs.io/en/stable/Python-API.html), [scikit-learn calibration](https://scikit-learn.org/stable/modules/calibration.html) and [PyArrow Parquet](https://arrow.apache.org/docs/python/parquet/parquet.html). Live account entitlements, model weights and production feed throughput were not tested.
