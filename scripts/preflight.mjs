// Real, read-only broker/database checks. Never prints credentials, URLs with tokens, or raw errors.
import "dotenv/config";
import console from "node:console";
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { loadConfig } from "../dist/src/config.js";
import { UpstoxProvider, ProviderError } from "../dist/src/providers/upstox.js";
import { MarketFeed } from "../dist/src/providers/feed.js";
import { createLogger } from "../dist/src/logger.js";
import { createModels } from "../dist/src/db/models.js";
import { MemoryStore } from "../dist/src/db/store.js";
import { NewsService } from "../dist/src/services/news.js";
import { AdditionalNewsProvider } from "../dist/src/providers/news.js";
import { aiStatus } from "../dist/src/services/models.js";
import { addDays, atIST, dayKey } from "../dist/src/market/time.js";

const targetDay = process.argv[2] ?? addDays(dayKey(Date.now()), 1);
if (
  !/^\d{4}-\d{2}-\d{2}$/.test(targetDay) ||
  !Number.isFinite(Date.parse(targetDay))
) {
  console.error("Use npm run preflight -- YYYY-MM-DD");
  process.exit(1);
}
const report = {
  checkedAt: new Date().toISOString(),
  targetDay,
  checks: {},
  peakRssMB: 0,
};
const check = async (name, action) => {
  try {
    const detail = await action();
    report.checks[name] = { status: "READY", ...detail };
  } catch (e) {
    report.checks[name] = {
      status: "BLOCKED",
      reason:
        e instanceof ProviderError
          ? `UPSTOX_HTTP_${e.status}`
          : e?.name === "MongoParseError"
            ? "MONGODB_URI_INVALID_FORMAT"
            : e instanceof mongoose.Error || e?.name?.startsWith("Mongo")
              ? "MONGODB_CONNECTION_OR_AUTH_FAILED"
              : "REQUEST_OR_RESPONSE_VALIDATION_FAILED",
    };
  }
  console.log(`${name}: ${report.checks[name].status}`);
};
let config;
try {
  config = loadConfig({
    ...process.env,
    DATA_MODE: "live",
    STORAGE_MODE: "mongo",
  });
} catch {
  console.error(
    "BLOCKED: invalid live environment; check required variable names in .env.example",
  );
  process.exit(1);
}
const provider = new UpstoxProvider(config);
const keys = config.UPSTOX_UNDERLYING_KEYS.length
  ? config.UPSTOX_UNDERLYING_KEYS.slice(0, config.MAX_UNDERLYINGS)
  : ["NSE_INDEX|Nifty 50", "NSE_INDEX|Nifty Bank"];
report.checks.ai = {
  status: config.AI_ENABLED ? "BLOCKED" : "READY",
  models: aiStatus(config),
  execution: "No model calls made by preflight",
};
await check("mongodb", async () => {
  const connection = mongoose.createConnection(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 2,
    autoCreate: false,
    autoIndex: false,
  });
  try {
    await connection.asPromise();
    const hello = await connection.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid")
      return { status: "BLOCKED", reason: "REPLICA_SET_REQUIRED" };
    const available = new Set(
      (
        await connection.db.listCollections({}, { nameOnly: true }).toArray()
      ).map((c) => c.name),
    );
    const missing = [];
    for (const [name, model] of Object.entries(createModels(connection))) {
      if (!available.has(name)) {
        missing.push(name);
        continue;
      }
      const indexes = await connection.db
        .collection(name)
        .listIndexes()
        .toArray();
      for (const [key, options] of model.schema.indexes())
        if (
          !indexes.some(
            (i) =>
              JSON.stringify(i.key) === JSON.stringify(key) &&
              Boolean(i.unique) === Boolean(options.unique) &&
              i.expireAfterSeconds === options.expireAfterSeconds,
          )
        )
          missing.push(`${name}:index`);
    }
    return {
      status: missing.length ? "BLOCKED" : "READY",
      connectivity: "READY",
      replicaSet: true,
      missingIndexesOrCollections: [...new Set(missing)],
      note: "Read-only check; persistent worker startup initializes required indexes",
    };
  } finally {
    await connection.close().catch(() => {});
  }
});
await check("authentication", async () => {
  const quotes = await provider.quotes(keys);
  return {
    status: quotes.length ? "READY" : "BLOCKED",
    quoteCount: quotes.length,
    receivedAt: Date.now(),
    newestSourceAt: quotes.length
      ? Math.max(...quotes.map((q) => q.sourceTs))
      : null,
    note: "Successful read-only request does not imply quotes are fresh outside market hours",
  };
});
await check("calendar", async () => {
  const session = await provider.session(targetDay);
  return {
    status: session.verified && session.trading ? "READY" : "BLOCKED",
    session,
  };
});
let instruments = [];
await check("instruments", async () => {
  instruments = await provider.instruments();
  const missing = keys.filter(
    (k) => !instruments.some((i) => i.id === k && i.active),
  );
  return {
    status: missing.length ? "BLOCKED" : "READY",
    count: instruments.length,
    requested: keys,
    missing,
  };
});
const history = [];
for (const key of keys) {
  const item = instruments.find((i) => i.id === key);
  const proxy =
    item?.kind === "INDEX"
      ? instruments
          .filter(
            (i) =>
              i.underlyingKey === key &&
              i.kind === "FUT" &&
              i.active &&
              i.expiry > targetDay,
          )
          .sort((a, b) => a.expiry.localeCompare(b.expiry))[0]?.id
      : key;
  await check(`history:${key}`, async () => {
    const to = addDays(dayKey(Date.now()), -1),
      from = addDays(to, -Math.ceil(config.BASELINE_SESSIONS * 2.5));
    const price = await provider.historyWindow(key, from, to);
    const volume =
      proxy === key
        ? price
        : proxy
          ? await provider.historyWindow(proxy, from, to)
          : [];
    const sessions = new Set(
      volume
        .filter((c) => c.complete && c.volume !== null)
        .map((c) => dayKey(c.start)),
    ).size;
    const row = {
      instrumentKey: key,
      volumeProxy: proxy ?? null,
      from,
      to,
      priceCandles: price.length,
      volumeCandles: volume.length,
      sessions,
      minimum: config.BASELINE_MIN_SAMPLES,
    };
    history.push(row);
    return {
      ...row,
      status:
        price.length && sessions >= config.BASELINE_MIN_SAMPLES
          ? "READY"
          : "BLOCKED",
      note: "Session count is a preliminary coverage check; each same-time RVOL metric still validates its own samples. Not persisted by this probe.",
    };
  });
  await check(`optionChain:${key}`, async () => {
    const expiry = instruments
      .filter(
        (i) =>
          i.underlyingKey === key && i.kind === "CE" && i.expiry > targetDay,
      )
      .map((i) => i.expiry)
      .sort()[0];
    if (!expiry) return { status: "BLOCKED", reason: "NO_LISTED_EXPIRY" };
    const quotes = await provider.chain(key, expiry);
    return {
      status: quotes.length ? "READY" : "BLOCKED",
      expiry,
      quotes: quotes.length,
      note: "No contract prices are synthesized",
    };
  });
}
await check("upstoxNews", async () => ({
  articles: (await provider.news(keys)).length,
}));
const extra = new AdditionalNewsProvider(config);
for (const [name, action, enabled] of [
  ["nseNews", () => extra.rss(config.NSE_RSS_URL), config.NSE_RSS_URL],
  ["rbiNews", () => extra.rss(config.RBI_RSS_URL), config.RBI_RSS_URL],
  ["gnews", () => extra.gnews(), config.GNEWS_API_KEY],
  ["newsapi", () => extra.newsapi(), config.NEWSAPI_KEY],
  ...config.RSS_FEED_URLS.map((url, i) => [
    `rss${i}`,
    () => extra.rss(url),
    true,
  ]),
]) {
  if (enabled)
    await check(name, async () => ({ articles: (await action()).length }));
  else
    report.checks[name] = {
      status: "BLOCKED",
      reason: "NOT_CONFIGURED",
      optional: true,
    };
}
await check("websocket", async () => {
  await provider.authorizeFeed(); // Distinguish access failure before starting the bounded socket probe.
  let decodedFrames = 0,
    quoteCount = 0,
    connected = false;
  const feedKeys = [
    ...new Set([...keys, ...history.map((h) => h.volumeProxy).filter(Boolean)]),
  ];
  const feed = new MarketFeed(
    provider,
    config,
    createLogger("silent"),
    (data) => {
      decodedFrames++;
      quoteCount += data.quotes.length;
    },
    () => {
      connected = true;
    },
  );
  try {
    await feed.start(feedKeys);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && quoteCount === 0)
      await new Promise((r) => setTimeout(r, 250));
    return {
      status: connected && quoteCount > 0 ? "READY" : "BLOCKED",
      connected,
      decodedFrames,
      quoteCount,
      subscriptions: feedKeys.length,
      note: "Requires actual decoded quote frames; an open socket alone is insufficient. Recheck before market open.",
    };
  } finally {
    feed.stop();
  }
});
await check("eventRiskCalendar", async () => {
  const service = new NewsService(new MemoryStore(), config, null);
  await service.loadEvents();
  const covered = service.isCalendarReady(atIST(targetDay, "09:15"));
  return {
    status: covered ? "READY" : "BLOCKED",
    reason: covered
      ? "REVIEWED_CALENDAR_COVERAGE_LOADED"
      : "EVENT_CALENDAR_MISSING_OR_OUTSIDE_VALIDITY",
    required: config.REQUIRE_EVENT_CALENDAR,
  };
});
report.checks.costAssumptions = {
  status: config.COSTS_VERIFIED ? "READY" : "BLOCKED",
  reason: config.COSTS_VERIFIED
    ? "OPERATOR_MARKED_VERIFIED"
    : "COSTS_NOT_VERIFIED",
};
report.peakRssMB = Math.round(process.resourceUsage().maxRSS / 1024);
await mkdir("artifacts", { recursive: true });
await writeFile(
  `artifacts/preflight-${targetDay}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(`Sanitized report: artifacts/preflight-${targetDay}.json`);
process.exitCode = Object.values(report.checks).some(
  (c) => c.status === "BLOCKED" && !c.optional,
)
  ? 2
  : 0;
