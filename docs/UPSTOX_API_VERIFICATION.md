# Upstox API verification

Documentation checked against official Upstox pages on **21 October 2026**. No authenticated live requests were tested because no Analytics Token was supplied. Unit fixtures exercise normalization and wire shape; they do not prove broker entitlement, freshness or market accuracy.

| Capability                 | Implemented contract                                                                                      | Official reference                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Analytics authentication   | Bearer Analytics Token; no order/trading client                                                           | [API overview](https://upstox.com/developer/api-documentation/)                                        |
| Instruments                | NSE JSON gzip master; `instrument_key` identity, metadata-driven lot/strike/expiry                        | [Instruments](https://upstox.com/developer/api-documentation/instruments/)                             |
| Listed options             | `GET /v2/option/contract` and listed master metadata                                                      | [Option contracts](https://upstox.com/developer/api-documentation/get-option-contracts/)               |
| Option chains              | `GET /v2/option/chain`; expiry-specific legs and Greeks                                                   | [Put/call chain](https://upstox.com/developer/api-documentation/get-pc-option-chain/)                  |
| Executable quote snapshots | `GET /v3/market-quote/quotes`; maximum 500 keys/request                                                   | [Full quote V3](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)              |
| Historical bars            | `GET /v3/historical-candle/{key}/{unit}/{interval}/{to}/{from}`; short windows split into 28-day requests | [Historical candles V3](https://upstox.com/developer/api-documentation/v3/get-historical-candle-data/) |
| Intraday reconciliation    | `GET /v3/historical-candle/intraday/{key}/minutes/{interval}`                                             | [Intraday candles V3](https://upstox.com/developer/api-documentation/v3/get-intra-day-candle-data/)    |
| Feed authorization         | `GET /v3/feed/market-data-feed/authorize`; new one-use URL per connection                                 | [V3 authorization](https://upstox.com/developer/api-documentation/get-market-data-feed-authorize-v3/)  |
| WebSocket V3               | Binary JSON subscriptions, full mode, protobuf payloads, ping/pong and reconnect                          | [Feed V3](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/)                     |
| Session/holiday handling   | `GET /v2/market/timings/{date}`, NFO entry; no entry means closed                                         | [Market timings](https://upstox.com/developer/api-documentation/get-market-timings/)                   |
| Financial news             | `GET /v2/news?category=instrument_keys`, ≤30 keys; explicit published timestamps                          | [News](https://upstox.com/developer/api-documentation/get-news/)                                       |
| India VIX                  | `NSE_INDEX\|India VIX` quote/feed subscription                                                            | [Full quote V3](https://upstox.com/developer/api-documentation/get-full-market-quote-v3/)              |

The implementation uses the current V3 quote API rather than assuming the older V2 quote shape. The broker currently exposes a supported news API; it is implemented rather than replaced with unofficial scraping. News results are collected from the first page of recent articles; this is not a complete archival news feed.

The JSON master publishes a raw tick value such as `5` while INR market quotes use decimal rupees. The adapter stores `rawTickSize` and normalizes JSON ticks by 100 (e.g. `5 → ₹0.05`). This is an explicit adapter convention consistent with the official JSON/deprecated CSV examples; validate it against your actual listed contracts when live access is configured. Strike, expiry and lot size are never inferred from symbol spelling or hard-coded index lot rules.

The standard connection limit is two per user. This service uses one socket, full mode, and defaults to 500 subscriptions with a conservative configurable ceiling of 1,500. It does not use Plus-only depth modes. REST request pacing defaults to five requests/second; retries honour bounded `Retry-After` values. Account-specific permissions and rate policies still need verification with the supplied token.

Option-chain responses do not supply an exchange quote timestamp. Their prices cannot authorize an entry. Chain Greek context is joined to fresh feed/REST quotes. REST response time and last-trade time are separate fields. OI source-update timestamps remain unavailable unless explicitly supplied; no inferred real-time OI timestamp or participant identity is produced.

The official Protobuf file is vendored at `proto/MarketDataFeed.proto`; wrapper imports are resolved by protobufjs. Source: [MarketDataFeed.proto](https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto). SHA-256 at retrieval:

```text
3e1c939dce2c83a3fef91405c5ca268dfa089aae973319f56685f12a5afcf612
```

The protocol definition belongs to Upstox; it is retained for wire compatibility. Recheck the official schema and adapter tests before upgrading it.

Historical/expired option access varies by entitlement and available data. This implementation does not fabricate depth/Greeks from expired OHLC. Its executable historical replay is limited to stored point-in-time quotes and metadata; a broader licensed expired-history import pipeline remains future work. Global macro/sector datasets and complete corporate event calendars likewise require separately permitted sources.

## Advanced-news update verification

On 22 October 2026, the news and V3 feed contracts were rechecked against the official references above. The existing Upstox GET adapters were retained. New adapters use permitted configured RSS XML URLs, GNews search and NewsAPI Everything; local event extraction uses the Ollama `/api/chat` structured-output contract. No live account call or entitlement claim was added. The [advanced research guide](ADVANCED_RESEARCH.md) lists the model, storage and archive references and current data limitations.
