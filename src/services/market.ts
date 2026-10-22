import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type {
  Candle,
  Instrument,
  InstrumentVersion,
  MarketSession,
  Quote,
  VolumeProfile,
} from '../domain.js';
import type { Store } from '../db/store.js';
import { UpstoxProvider } from '../providers/upstox.js';
import { MarketFeed } from '../providers/feed.js';
import { CandleBuilder, aggregateCandles, candleId } from '../market/candles.js';
import { addDays, dayKey, minuteOfDay, atIST, MINUTE } from '../market/time.js';
import { MinuteSampler, compactOptions } from '../market/sampling.js';
import { IncrementalVolumeState } from '../engines/advanced-volume.js';
export function sameCandleObservation(a: Candle, b: Candle): boolean {
  return (
    a.start === b.start &&
    a.end === b.end &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    a.oi === b.oi &&
    a.complete === b.complete &&
    JSON.stringify(a.quality) === JSON.stringify(b.quality)
  );
}
export class MarketService {
  snapshotStride = 1;
  readonly watchedKeys = new Set<string>();
  private sampler = new MinuteSampler();
  private pendingVersions = new Map<string, InstrumentVersion>();
  private snapshotKeys = new Set<string>();
  private flushing = false;
  private lastFlushMinute = -1;
  readonly volumeState = new IncrementalVolumeState();
  private recordedVersions = new Set<string>();
  readonly quotes = new Map<string, Quote>();
  readonly instruments = new Map<string, Instrument>();
  session: MarketSession | null = null;
  underlyings: Instrument[] = [];
  volumeKeys = new Map<string, string>();
  feed: MarketFeed | null = null;
  private builder = new CandleBuilder();
  private ingestion: Promise<void> = Promise.resolve();
  private pending = 0;
  private reconcileNeeded = false;
  private preparedDay: string | null = null;
  private monitoring: ((q: Quote) => Promise<void>) | null = null;
  private protectedKeys: string[] = [];
  constructor(
    readonly store: Store,
    readonly config: Config,
    readonly provider: UpstoxProvider | null,
    private log: Logger,
  ) {
    this.snapshotStride = config.DATA_MODE === 'live' ? 0 : 1;
  }
  selectSnapshots(keys: Iterable<string>) {
    this.snapshotKeys = new Set([...keys].slice(0, this.config.MAX_SNAPSHOT_INSTRUMENTS));
  }
  private collectsCandles(key: string) {
    return this.underlyings.some((i) => i.id === key) || [...this.volumeKeys.values()].includes(key);
  }
  onQuote(callback: (q: Quote) => Promise<void>) {
    this.monitoring = callback;
  }
  async load() {
    for (const i of await this.store.find('instruments', {}, { limit: 100000 }))
      this.instruments.set(i.id, i);
    const latest = await this.store.find('option_snapshots', {}, { sort: { sourceTs: -1 }, limit: 5000 });
    for (const q of latest) if (!this.quotes.has(q.instrumentKey)) this.quotes.set(q.instrumentKey, q);
    for (const q of this.quotes.values())
      if (
        ['CE', 'PE', 'FUT'].includes(this.instruments.get(q.instrumentKey)?.kind ?? '') &&
        this.snapshotKeys.size < this.config.MAX_SNAPSHOT_INSTRUMENTS
      )
        this.snapshotKeys.add(q.instrumentKey);
    for (const trade of await this.store.find('paper_trades', { status: 'OPEN' }))
      this.watchedKeys.add(trade.instrumentKey);
    for (const signal of await this.store.find('trade_signals', { day: dayKey(Date.now()) })) {
      this.watchedKeys.add(signal.contract.id);
      this.watchedKeys.add(signal.underlying.id);
    }
  }
  async loadSession(now: number) {
    if (this.provider) {
      this.session = await this.provider.session(dayKey(now));
      await this.store.put('market_sessions', this.session);
    } else this.session = await this.store.get('market_sessions', dayKey(now));
    return this.session;
  }
  async loadUniverse(now = Date.now()) {
    if (!this.provider) return;
    const day = dayKey(now);
    const all = await this.provider.instruments();
    if (!all.length) throw new Error('Empty instrument master');
    const eligibleUnderlying = new Set(
      all.filter((i) => ['CE', 'PE'].includes(i.kind) && i.active).map((i) => i.underlyingKey),
    );
    const selected = all
      .filter(
        (i) =>
          ['INDEX', 'EQUITY'].includes(i.kind) &&
          eligibleUnderlying.has(i.id) &&
          (!this.config.UPSTOX_UNDERLYING_KEYS.length || this.config.UPSTOX_UNDERLYING_KEYS.includes(i.id)),
      )
      .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'INDEX' ? -1 : 1))
      .slice(0, this.config.MAX_UNDERLYINGS);
    if (!selected.length) throw new Error('No configured underlying has listed F&O contracts');
    const selectedIds = new Set(selected.map((i) => i.id)),
      universe = all.filter(
        (i) => selectedIds.has(i.id) || selectedIds.has(i.underlyingKey) || i.id === 'NSE_INDEX|India VIX',
      );
    this.instruments.clear();
    this.volumeKeys.clear();
    this.recordedVersions.clear();
    this.volumeState.reset();
    this.watchedKeys.clear();
    for (const t of await this.store.find('paper_trades', { status: 'OPEN' }))
      this.watchedKeys.add(t.instrumentKey);
    for (const s of await this.store.find('trade_signals', { day })) {
      this.watchedKeys.add(s.contract.id);
      this.watchedKeys.add(s.underlying.id);
    }
    for (const i of universe) {
      this.instruments.set(i.id, i);
    }
    await this.store.putMany('instruments', universe);
    this.underlyings = selected;
    for (const u of selected) {
      if (u.kind === 'INDEX') {
        const future = universe
          .filter((i) => i.kind === 'FUT' && i.underlyingKey === u.id && i.active && i.expiry! > day)
          .sort((a, b) => a.expiry!.localeCompare(b.expiry!))[0];
        if (future) this.volumeKeys.set(u.id, future.id);
      } else this.volumeKeys.set(u.id, u.id);
    }
  }
  async prepare(now = Date.now(), options: { stream: boolean } = { stream: true }) {
    if (!this.provider) return;
    const day = dayKey(now);
    await this.loadSession(now);
    if (!this.session?.trading) return;
    await this.loadUniverse(now);
    const tracked = [...new Set([...this.underlyings.map((i) => i.id), ...this.volumeKeys.values()])];
    for (const key of tracked) {
      const profiles = await this.store.find(
        'market_volume_profiles',
        { instrumentKey: key, day: { $lt: day } },
        { limit: 1 },
      );
      const from = profiles.length
        ? addDays(day, -4)
        : addDays(day, -Math.ceil(this.config.BASELINE_SESSIONS * 2.1));
      const history = await this.provider.historyWindow(key, from, addDays(day, -1));
      await this.persistHistory(history, Date.now());
      const daily = await this.provider.historyWindow(key, addDays(day, -90), addDays(day, -1), 1440);
      await this.persistHistory(daily, Date.now());
    }
    const baseQuotes = await this.provider.quotes([...tracked, 'NSE_INDEX|India VIX']);
    for (const q of baseQuotes) await this.acceptQuote(q);
    await this.refreshContracts(now);
    const subscriptions = this.subscriptionPriorities();
    if (options.stream && !this.feed) {
      this.feed = new MarketFeed(
        this.provider,
        this.config,
        this.log,
        (data) => this.enqueue(data),
        () => {
          this.builder.reset();
          this.reconcileNeeded = true;
        },
      );
      await this.feed.start(subscriptions);
    } else if (options.stream) this.feed?.updateSubscriptions(subscriptions);
    this.preparedDay = day;
    await this.reconcile(now);
  }
  isPrepared(day: string) {
    return this.preparedDay === day;
  }
  subscriptionPriorities() {
    return [
      ...new Set([
        ...this.protectedKeys,
        ...this.underlyings.map((i) => i.id),
        ...this.volumeKeys.values(),
        'NSE_INDEX|India VIX',
        ...[...this.quotes.values()]
          .filter(
            (q) =>
              ['CE', 'PE'].includes(this.instruments.get(q.instrumentKey)?.kind ?? '') && q.delta !== null,
          )
          .map((q) => q.instrumentKey),
      ]),
    ].slice(0, this.config.MAX_SUBSCRIPTIONS);
  }
  async refreshContracts(now: number) {
    if (!this.provider) return;
    this.protectedKeys = (await this.store.find('paper_trades', { status: 'OPEN' })).map(
      (t) => t.instrumentKey,
    );
    this.selectSnapshots(this.protectedKeys);
    for (const key of this.volumeKeys.values())
      if (
        this.instruments.get(key)?.kind === 'FUT' &&
        this.snapshotKeys.size < this.config.MAX_SNAPSHOT_INSTRUMENTS
      )
        this.snapshotKeys.add(key);
    for (const key of this.protectedKeys)
      if (!this.instruments.has(key)) {
        const stored = await this.store.get('instruments', key);
        if (stored) this.instruments.set(key, stored);
      }
    for (const u of this.underlyings) {
      const contracts = [...this.instruments.values()].filter(
        (i) =>
          i.underlyingKey === u.id && ['CE', 'PE'].includes(i.kind) && i.active && i.expiry! >= dayKey(now),
      );
      const expiries = [...new Set(contracts.map((i) => i.expiry!))].sort().slice(0, 2);
      for (const expiry of expiries) {
        const chain = await this.provider.chain(u.id, expiry);
        const underlying = this.quotes.get(u.id)?.ltp;
        const selected = chain
          .filter(
            (q) =>
              contracts.some((i) => i.id === q.instrumentKey) &&
              q.delta !== null &&
              Math.abs(q.delta) >= 0.25 &&
              Math.abs(q.delta) <= 0.8,
          )
          .sort((a, b) => {
            const ia = this.instruments.get(a.instrumentKey)!,
              ib = this.instruments.get(b.instrumentKey)!;
            return underlying
              ? Math.abs(ia.strike! - underlying) - Math.abs(ib.strike! - underlying)
              : (b.cumulativeVolume ?? 0) - (a.cumulativeVolume ?? 0);
          })
          .slice(0, this.config.MAX_NEARBY_OPTION_LEGS);
        for (const q of selected)
          if (this.snapshotKeys.size < this.config.MAX_SNAPSHOT_INSTRUMENTS)
            this.snapshotKeys.add(q.instrumentKey);
        const executable = await this.provider.quotes(selected.map((q) => q.instrumentKey));
        for (const q of executable) {
          const chainQuote = selected.find((s) => s.instrumentKey === q.instrumentKey)!;
          await this.acceptQuote({
            ...q,
            delta: chainQuote.delta,
            gamma: chainQuote.gamma,
            theta: chainQuote.theta,
            iv: chainQuote.iv,
            previousOi: chainQuote.previousOi,
          });
        }
      }
    }
    this.feed?.updateSubscriptions(this.subscriptionPriorities());
    const subscribed = new Set(this.subscriptionPriorities());
    for (const key of this.quotes.keys())
      if (!subscribed.has(key) && !this.watchedKeys.has(key)) this.quotes.delete(key);
  }
  private enqueue(data: { quotes: Quote[]; candles: Candle[] }) {
    if (this.pending > 200) {
      this.reconcileNeeded = true;
      this.log.warn('Feed processing backlog; dropping frame and requiring reconciliation');
      return;
    }
    this.pending++;
    this.ingestion = this.ingestion
      .then(async () => {
        for (const c of data.candles) if (this.collectsCandles(c.instrumentKey)) await this.persistCandle(c);
        for (const q of data.quotes) await this.acceptQuote(q);
      })
      .catch(() => {
        this.reconcileNeeded = true;
        this.log.error('Feed ingestion failed; reconciliation required');
      })
      .finally(() => {
        this.pending--;
      });
  }
  async acceptQuote(q: Quote) {
    const prior = this.quotes.get(q.instrumentKey);
    if (prior && prior.sourceTs > q.sourceTs) return;
    if (!Number.isFinite(q.ltp) || q.ltp <= 0 || q.sourceTs > q.receivedAt + 2000) return;
    const instrument = this.instruments.get(q.instrumentKey);
    if (instrument) {
      const versionId = `${instrument.id}:${instrument.asOf}`;
      if (!this.recordedVersions.has(versionId)) {
        this.pendingVersions.set(versionId, {
          id: versionId,
          instrumentKey: instrument.id,
          asOf: instrument.asOf,
          instrument,
          mode: instrument.mode,
        });
        this.recordedVersions.add(versionId);
      }
    }
    if (q.previousOi === null && prior) q = { ...q, previousOi: prior.previousOi };
    this.quotes.set(q.instrumentKey, q);
    const selected = this.snapshotKeys.has(q.instrumentKey);
    if (
      this.config.SNAPSHOTS_ENABLED &&
      this.snapshotStride > 0 &&
      selected &&
      Math.floor(q.sourceTs / MINUTE) % this.snapshotStride === 0
    )
      this.sampler.observe(q);
    this.sampler.trim(Math.max(1, this.config.MAX_SNAPSHOT_INSTRUMENTS) * 10);
    if (this.session && this.collectsCandles(q.instrumentKey)) {
      for (const c of this.builder.push(
        q,
        this.session.open,
        this.session.close,
        this.instruments.get(q.instrumentKey)?.kind === 'INDEX',
      ))
        await this.persistCandle(c);
    }
    if (this.watchedKeys.has(q.instrumentKey)) await this.monitoring?.(q);
  }
  async flushObservations(now: number) {
    const minute = Math.floor(now / MINUTE);
    if (this.flushing || this.lastFlushMinute === minute) return;
    this.flushing = true;
    try {
      const versions = [...this.pendingVersions.values()];
      if (versions.length) {
        await this.store.insertMany('instrument_versions', versions);
        for (const v of versions) this.pendingVersions.delete(v.id);
      }
      if (this.snapshotStride === 0 || !this.config.SNAPSHOTS_ENABLED) this.sampler.clear();
      const rows = this.sampler.completed(now);
      await this.store.insertMany('option_snapshots', rows);
      const groups = [
        ...new Set(
          rows.map((q) => `${q.instrumentKey}~${Math.floor(q.sourceTs / (5 * MINUTE)) * 5 * MINUTE}`),
        ),
      ];
      // Include the previous five-minute bucket on restart/rollover even if its last sample preceded close.
      if (minute % 5 === 0)
        for (const key of this.snapshotKeys)
          groups.push(`${key}~${Math.floor(now / (5 * MINUTE)) * 5 * MINUTE - 5 * MINUTE}`);
      for (const group of new Set(groups)) {
        const [key, text] = group.split('~') as [string, string],
          start = Number(text);
        if (start + 5 * MINUTE > now) continue;
        const samples = await this.store.find(
          'option_snapshots',
          { instrumentKey: key, sourceTs: { $gte: start, $lt: start + 5 * MINUTE } },
          { sort: { sourceTs: 1 }, limit: 10000 },
        );
        const compact = compactOptions(samples, start, now);
        if (compact) {
          await this.store.put('option_aggregates', compact);
          await this.store.armRetention(
            'option_snapshots',
            samples.map((q) => q.id),
            compact.end + this.config.SNAPSHOT_RETENTION_DAYS * 86400000,
          );
        }
      }
      this.sampler.acknowledge(rows);
      this.lastFlushMinute = minute;
    } finally {
      this.flushing = false;
    }
  }
  async persistCandle(c: Candle) {
    if (!c.complete) return;
    const previous = (
      await this.store.find(
        'market_candles',
        { instrumentKey: c.instrumentKey, interval: c.interval, start: c.start },
        { limit: 1 },
      )
    )[0];
    c = { ...c, id: previous?.id ?? candleId(c.instrumentKey, c.interval, c.start) };
    // Exact provider OHLC replaces tick approximations; later tick flushes cannot overwrite reconciliation.
    if (previous && previous.source !== 'upstox-v3-ticks' && c.source === 'upstox-v3-ticks') return;
    if (previous && sameCandleObservation(previous, c)) return;
    this.volumeState.observe(c);
    await this.store.put('market_candles', c);
    if (c.interval === 1 && this.session && dayKey(c.start) === this.session.day) {
      for (const interval of [5, 15, 30]) {
        const start =
          this.session.open +
          Math.floor((c.start - this.session.open) / (interval * MINUTE)) * interval * MINUTE;
        if (start < this.session.open || start + interval * MINUTE > this.session.close) continue;
        const rows = await this.store.find('market_candles', {
          instrumentKey: c.instrumentKey,
          interval: 1,
          start: { $gte: start, $lt: start + interval * MINUTE },
        });
        const combined = aggregateCandles(rows, interval, start, c.receivedAt);
        if (combined) await this.store.put('market_candles', combined);
      }
    }
  }
  async persistHistory(candles: Candle[], now: number) {
    candles = candles.filter((c) => c.complete && c.end <= now && c.receivedAt <= now);
    if (!candles.length) return;
    if (candles.some((c) => c.instrumentKey !== candles[0]!.instrumentKey))
      throw new Error('History batch must contain one instrument');
    const key = candles[0]!.instrumentKey,
      minStart = Math.min(...candles.map((c) => c.start)),
      maxEnd = Math.max(...candles.map((c) => c.end));
    const logicalId = (c: Candle) => candleId(c.instrumentKey, c.interval, c.start);
    const previous = new Map(
      (
        await this.store.find(
          'market_candles',
          { instrumentKey: key, start: { $gte: minStart, $lt: maxEnd } },
          { limit: 100000 },
        )
      ).map((c) => [logicalId(c), c]),
    );
    const output = new Map<string, Candle>();
    const add = (c: Candle) => {
      const key = logicalId(c),
        old = previous.get(key);
      output.set(key, old && sameCandleObservation(old, c) ? old : { ...c, id: old?.id ?? key });
    };
    for (const c of candles) add(c);
    const groups = new Map<string, Candle[]>();
    for (const c of output.values()) {
      if (c.interval !== 1) continue;
      const d = dayKey(c.start);
      if (!groups.has(d)) groups.set(d, []);
      groups.get(d)!.push(c);
    }
    const sessions = new Map(
      (
        await this.store.find('market_sessions', { day: { $gte: dayKey(minStart), $lte: dayKey(maxEnd) } })
      ).map((s) => [s.day, s]),
    );
    for (const [day, rows] of groups) {
      const session = sessions.get(day);
      const open = session?.open ?? atIST(day, '09:15'),
        close = session?.close ?? atIST(day, '15:30');
      for (const interval of [5, 15, 30])
        for (let start = open; start + interval * MINUTE <= close; start += interval * MINUTE) {
          const c = aggregateCandles(rows, interval, start, now);
          if (!c) continue;
          add(c);
        }
    }
    await this.store.putMany('market_candles', [...output.values()]);
    const profileId = (p: Pick<VolumeProfile, 'instrumentKey' | 'day' | 'interval' | 'minute'>) =>
      `${p.instrumentKey}:${p.day}:${p.interval}:${p.minute}`;
    const oldProfiles = new Map(
      (
        await this.store.find(
          'market_volume_profiles',
          { instrumentKey: key, day: { $gte: dayKey(minStart), $lte: dayKey(maxEnd) } },
          { limit: 100000 },
        )
      ).map((p) => [profileId(p), p]),
    );
    const profiles: VolumeProfile[] = [];
    for (const c of output.values()) {
      const dimensions = {
          instrumentKey: c.instrumentKey,
          day: dayKey(c.start),
          minute: minuteOfDay(c.start),
          interval: c.interval,
        },
        id = profileId(dimensions),
        old = oldProfiles.get(id);
      const valid = c.complete && c.volume !== null && c.quality.length === 0;
      if (!valid && !old) continue;
      profiles.push({
        ...dimensions,
        id: old?.id ?? id,
        volume: c.volume ?? 0,
        valid,
        receivedAt: old && old.volume === (c.volume ?? 0) && old.valid === valid ? old.receivedAt : now,
        mode: c.mode,
      });
    }
    await this.store.putMany('market_volume_profiles', profiles);
  }
  async reconcile(now: number) {
    if (!this.provider || !this.session || now < this.session.open) return;
    for (const key of [...new Set([...this.underlyings.map((i) => i.id), ...this.volumeKeys.values()])]) {
      const stored = new Map(
        (
          await this.store.find('market_candles', {
            instrumentKey: key,
            interval: 1,
            start: { $gte: this.session.open, $lt: this.session.close },
          })
        ).map((c) => [c.id, c]),
      );
      for (const c of await this.provider.intraday(key)) {
        const old = stored.get(c.id);
        if (!old || !sameCandleObservation(old, c)) await this.persistCandle(c);
      }
    }
    this.reconcileNeeded = false;
  }
  async maintenance(now: number) {
    await this.flushObservations(now);
    for (const c of this.builder.flush(now, this.config.CANDLE_GRACE_MS)) await this.persistCandle(c);
    if (this.reconcileNeeded) await this.reconcile(now);
  }
  async stop() {
    this.feed?.stop();
    await this.ingestion;
    await this.flushObservations(Date.now());
  }
}
