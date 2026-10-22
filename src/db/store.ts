import mongoose, { type ClientSession, type Connection, type Model } from 'mongoose';
import type { Collection, Collections } from '../domain.js';
import { appendOnly, createModels } from './models.js';
import { automaticExpiry, defaultRetention, expirable, type RetentionPolicy } from './retention.js';
import type { DatabaseStorage } from '../advanced-domain.js';
export type Query = Record<string, unknown>;
export interface FindOptions {
  sort?: Record<string, 1 | -1>;
  limit?: number;
}
export interface Store {
  readonly persistent: boolean;
  get<K extends Collection>(name: K, id: string): Promise<Collections[K] | null>;
  find<K extends Collection>(name: K, query?: Query, options?: FindOptions): Promise<Collections[K][]>;
  insert<K extends Collection>(name: K, value: Collections[K]): Promise<void>;
  put<K extends Collection>(name: K, value: Collections[K]): Promise<void>;
  putMany<K extends Collection>(name: K, values: Collections[K][]): Promise<void>;
  insertMany<K extends Collection>(name: K, values: Collections[K][]): Promise<void>;
  armRetention(name: Collection, ids: string[], at: number): Promise<void>;
  deferRetention(name: Collection, ids: string[], until: number): Promise<void>;
  storageStats(): Promise<DatabaseStorage>;
  transaction<T>(work: (store: Store) => Promise<T>): Promise<T>;
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}
export class ConflictError extends Error {
  constructor() {
    super('Record already exists');
  }
}
function field(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
      obj,
    );
}
function compare(a: unknown, b: unknown): number {
  return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
}
function matches(row: unknown, query: Query): boolean {
  return Object.entries(query).every(([k, v]) => {
    if (k === '$or') return (v as Query[]).some((q) => matches(row, q));
    const actual = field(row, k);
    if (v && typeof v === 'object' && !Array.isArray(v))
      return Object.entries(v).every(([op, val]) => {
        if (op === '$lte') return compare(actual, val) <= 0;
        if (op === '$lt') return compare(actual, val) < 0;
        if (op === '$gte') return compare(actual, val) >= 0;
        if (op === '$gt') return compare(actual, val) > 0;
        if (op === '$ne') return actual !== val;
        if (op === '$exists') return (actual !== undefined) === val;
        if (op === '$in') return (val as unknown[]).includes(actual);
        throw new Error(`Unsupported fixture query: ${op}`);
      });
    return Array.isArray(actual) ? actual.includes(v) : actual === v;
  });
}
/** Ephemeral fixture cache; prohibited in live mode. */
export class MemoryStore implements Store {
  private expirations = new Map<Collection, Map<string, number>>();
  private retentionRetries = new Map<string, number>();
  async deferRetention(name: Collection, ids: string[], until: number) {
    if (!expirable.has(name) || !Number.isFinite(until)) throw new Error('Invalid retention retry');
    for (const id of ids) this.retentionRetries.set(`${name}:${id}`, until);
  }
  constructor(private policy: RetentionPolicy = defaultRetention) {}
  async insertMany<K extends Collection>(name: K, values: Collections[K][]) {
    for (const value of values)
      try {
        await this.insert(name, value);
      } catch (e) {
        if (!(e instanceof ConflictError)) throw e;
      }
  }
  async armRetention(name: Collection, ids: string[], at: number) {
    if (!expirable.has(name)) throw new Error('Essential audit records cannot expire');
    if (!Number.isFinite(at)) throw new Error('Invalid retention date');
    let map = this.expirations.get(name);
    if (!map) {
      map = new Map();
      this.expirations.set(name, map);
    }
    for (const id of ids) if (this.table(name).has(id)) map.set(id, at);
  }
  // Simulates MongoDB TTL for deterministic fixture tests; never connected to persistent data.
  expireFixtures(now: number) {
    let count = 0;
    for (const [name, dates] of this.expirations)
      for (const [id, at] of dates)
        if (at <= now) {
          this.table(name).delete(id);
          dates.delete(id);
          count++;
        }
    return count;
  }
  async storageStats(): Promise<DatabaseStorage> {
    const collections = [...this.rows].map(([name, rows]) => ({
      name,
      count: rows.size,
      dataBytes: Buffer.byteLength(JSON.stringify([...rows.values()])),
      storageBytes: 0,
      indexBytes: 0,
    }));
    return {
      measured: false,
      collections,
      dataBytes: collections.reduce((s, c) => s + c.dataBytes, 0),
      storageBytes: 0,
      indexBytes: 0,
      totalBytes: 0,
    };
  }
  private async trackExpiry<K extends Collection>(name: K, value: Collections[K]) {
    const at = automaticExpiry(name, value, this.policy);
    if (at !== null) await this.armRetention(name, [value.id], at);
  }
  readonly persistent = false;
  async putMany<K extends Collection>(name: K, values: Collections[K][]): Promise<void> {
    for (const value of values) await this.put(name, value);
  }
  private rows = new Map<Collection, Map<string, unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  private table(name: Collection) {
    let table = this.rows.get(name);
    if (!table) {
      table = new Map();
      this.rows.set(name, table);
    }
    return table;
  }
  async get<K extends Collection>(name: K, id: string): Promise<Collections[K] | null> {
    return structuredClone((this.table(name).get(id) as Collections[K]) ?? null);
  }
  async find<K extends Collection>(
    name: K,
    query: Query = {},
    options: FindOptions = {},
  ): Promise<Collections[K][]> {
    const rows = [...this.table(name).values()].filter((row) => {
      const value = row as { id: string };
      return matches({ ...value,
        retentionAt: this.expirations.get(name)?.get(value.id),
        retentionRetryAt: this.retentionRetries.get(`${name}:${value.id}`),
      }, query);
    });
    if (options.sort)
      rows.sort((a, b) => {
        for (const [k, d] of Object.entries(options.sort!)) {
          const n = compare(field(a, k), field(b, k)) * d;
          if (n) return n;
        }
        return 0;
      });
    return structuredClone(rows.slice(0, options.limit ?? 10000)) as Collections[K][];
  }
  async insert<K extends Collection>(name: K, value: Collections[K]): Promise<void> {
    const table = this.table(name);
    if (table.has(value.id)) throw new ConflictError();
    if (name === 'trade_signals') {
      const v = value as Collections['trade_signals'];
      if (
        [...table.values()].some((r) => {
          const s = r as typeof v;
          return (
            s.day === v.day &&
            (s.slot === v.slot || s.underlying.id === v.underlying.id || s.contract.id === v.contract.id)
          );
        })
      )
        throw new ConflictError();
    }
    if (name === 'paper_trades') {
      const v = value as Collections['paper_trades'];
      if (
        [...table.values()].some((r) => {
          const p = r as typeof v;
          return p.signalId === v.signalId || p.requestKey === v.requestKey;
        })
      )
        throw new ConflictError();
    }
    table.set(value.id, structuredClone(value));
    await this.trackExpiry(name, value);
  }
  async put<K extends Collection>(name: K, value: Collections[K]): Promise<void> {
    if (appendOnly.has(name)) throw new Error(`${name} is append-only`);
    this.table(name).set(value.id, structuredClone(value));
    await this.trackExpiry(name, value);
  }
  transaction<T>(work: (store: Store) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const snapshot = structuredClone(this.rows);
      const expirySnapshot = structuredClone(this.expirations);
      const retrySnapshot = structuredClone(this.retentionRetries);
      try {
        return await work(this);
      } catch (e) {
        this.rows = snapshot;
        this.expirations = expirySnapshot;
        this.retentionRetries = retrySnapshot;
        throw e;
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async healthy() {
    return true;
  }
  async close() {}
}
export class MongoStore implements Store {
  async deferRetention(name: Collection, ids: string[], until: number) {
    if (!expirable.has(name) || !Number.isFinite(until)) throw new Error('Invalid retention retry');
    for (let i = 0; i < ids.length; i += 500)
      await this.models[name].collection.updateMany(
        { id: { $in: ids.slice(i, i + 500) } },
        { $set: { retentionRetryAt: new Date(until) } }, { session: this.session });
  }
  private decorate<K extends Collection>(name: K, value: Collections[K]): Record<string, unknown> {
    const at = automaticExpiry(name, value, this.policy);
    return { ...value, ...(at === null ? {} : { retentionAt: new Date(at) }) };
  }
  async insertMany<K extends Collection>(name: K, values: Collections[K][]) {
    for (let i = 0; i < values.length; i += 500)
      try {
        await this.models[name].insertMany(
          values.slice(i, i + 500).map((v) => this.decorate(name, v)),
          { ordered: false, session: this.session },
        );
      } catch (e) {
        const error = e as { code?: number; writeErrors?: { code: number }[] };
        if (error.code !== 11000 || error.writeErrors?.some((w) => w.code !== 11000)) throw e;
      }
  }
  async armRetention(name: Collection, ids: string[], at: number) {
    if (!expirable.has(name)) throw new Error('Essential audit records cannot expire');
    if (!Number.isFinite(at)) throw new Error('Invalid retention date');
    for (let i = 0; i < ids.length; i += 500)
      await this.models[name].collection.updateMany(
        { id: { $in: ids.slice(i, i + 500) } },
        { $set: { retentionAt: new Date(at) } },
        { session: this.session },
      );
  }
  async storageStats(): Promise<DatabaseStorage> {
    const db = this.connection.db!;
    const summary = await db.command({ dbStats: 1, scale: 1 });
    const collections = [];
    for (const name of Object.keys(this.models)) {
      const s = await db.command({ collStats: name, scale: 1 });
      collections.push({
        name,
        count: Number(s.count ?? 0),
        dataBytes: Number(s.size ?? 0),
        storageBytes: Number(s.storageSize ?? 0),
        indexBytes: Number(s.totalIndexSize ?? 0),
      });
    }
    return {
      measured: true,
      collections,
      dataBytes: Number(summary.dataSize),
      storageBytes: Number(summary.storageSize),
      indexBytes: Number(summary.indexSize),
      totalBytes: Number(summary.storageSize) + Number(summary.indexSize),
    };
  }
  readonly persistent = true;
  async putMany<K extends Collection>(name: K, values: Collections[K][]): Promise<void> {
    if (appendOnly.has(name)) throw new Error(`${name} is append-only`);
    for (let i = 0; i < values.length; i += 1000) {
      const operations = values.slice(i, i + 1000).map((value) => ({
        replaceOne: {
          filter: { id: value.id },
          replacement: this.decorate(name, value),
          upsert: true,
        },
      }));
      await this.models[name].bulkWrite(operations, { ordered: true, session: this.session });
    }
  }
  private constructor(
    private connection: Connection,
    private models: Record<Collection, Model<Record<string, unknown>>>,
    private policy: RetentionPolicy,
    private session?: ClientSession,
  ) {}
  static async connect(
    uri: string,
    retentionDays = 7,
    policy: RetentionPolicy = { ...defaultRetention, snapshot: retentionDays },
  ): Promise<MongoStore> {
    const connection = await mongoose
      .createConnection(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 15 })
      .asPromise();
    const hello = await connection.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      await connection.close();
      throw new Error('MongoDB replica set required for atomic risk/accounting transactions');
    }
    const models = createModels(connection);
    await Promise.all(Object.values(models).map((m) => m.init()));
    return new MongoStore(connection, models, policy);
  }
  async get<K extends Collection>(name: K, id: string): Promise<Collections[K] | null> {
    return this.models[name]
      .findOne({ id })
      .session(this.session ?? null)
      .select({ _id: 0, retentionAt: 0, retentionRetryAt: 0 })
      .lean()
      .exec() as unknown as Promise<Collections[K] | null>;
  }
  async find<K extends Collection>(
    name: K,
    query: Query = {},
    options: FindOptions = {},
  ): Promise<Collections[K][]> {
    return this.models[name]
      .find(query)
      .session(this.session ?? null)
      .select({ _id: 0, retentionAt: 0, retentionRetryAt: 0 })
      .sort(options.sort ?? {})
      .limit(options.limit ?? 10000)
      .lean()
      .exec() as unknown as Promise<Collections[K][]>;
  }
  async insert<K extends Collection>(name: K, value: Collections[K]): Promise<void> {
    const row = this.decorate(name, value);
    try {
      const document = new this.models[name](row);
      await document.save({ session: this.session });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new ConflictError();
      throw e;
    }
  }
  async put<K extends Collection>(name: K, value: Collections[K]): Promise<void> {
    if (appendOnly.has(name)) throw new Error(`${name} is append-only`);
    await this.models[name].replaceOne({ id: value.id }, this.decorate(name, value), {
      upsert: true,
      runValidators: true,
      session: this.session,
    });
  }
  async transaction<T>(work: (store: Store) => Promise<T>): Promise<T> {
    if (this.session) return work(this);
    const session = await this.connection.startSession();
    try {
      return (await session.withTransaction(
        async () => {
          // Shared write serializes risk admission and accounting across service processes.
          await this.models.private_accounts.updateOne(
            { id: 'owner' },
            { $inc: { revision: 1 } },
            { session },
          );
          return work(new MongoStore(this.connection, this.models, this.policy, session));
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      )) as T;
    } finally {
      await session.endSession();
    }
  }
  async healthy() {
    try {
      await this.connection.db!.admin().ping();
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    await this.connection.close();
  }
}
