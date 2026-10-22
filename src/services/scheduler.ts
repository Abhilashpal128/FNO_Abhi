import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { Store } from '../db/store.js';
import type { Config } from '../config.js';
import type { Job } from '../domain.js';
import type { MarketService } from './market.js';
import type { NewsService } from './news.js';
import type { AnalysisService } from './analysis.js';
import type { PaperService } from './paper.js';
import { dayKey, sessionSchedule, type ScheduledTask, MINUTE, atIST } from '../market/time.js';
export class JobCoordinator {
  readonly owner = randomUUID();
  constructor(private store: Store) {}
  async claim(task: ScheduledTask, now: number): Promise<Job | null> {
    return this.store.transaction(async (db) => {
      const old = await db.get('data_ingestion_checkpoints', task.id);
      if (old && (old.status === 'DONE' || old.leaseUntil > now)) return null;
      const job: Job = {
        id: task.id,
        scheduledFor: task.at,
        kind: task.kind,
        status: 'RUNNING',
        owner: this.owner,
        leaseUntil: now + 60000,
        attempts: (old?.attempts ?? 0) + 1,
        finishedAt: null,
        error: null,
      };
      await db.put('data_ingestion_checkpoints', job);
      return job;
    });
  }
  async renew(id: string, now: number) {
    return this.store.transaction(async (db) => {
      const old = await db.get('data_ingestion_checkpoints', id);
      if (old?.owner !== this.owner || old.status !== 'RUNNING') return false;
      await db.put('data_ingestion_checkpoints', { ...old, leaseUntil: now + 60000 });
      return true;
    });
  }
  async finish(id: string, now: number, error: string | null = null, retry = false) {
    await this.store.transaction(async (db) => {
      const old = await db.get('data_ingestion_checkpoints', id);
      if (old?.owner !== this.owner || old.status !== 'RUNNING') return;
      await db.put('data_ingestion_checkpoints', {
        ...old,
        status: error || retry ? 'FAILED' : 'DONE',
        finishedAt: now,
        leaseUntil: retry || error ? now + 15000 : 0,
        error,
      });
    });
  }
}
export class MarketScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private active: Promise<void> = Promise.resolve();
  private stopped = false;
  private lastReconcile = 0;
  private lastNews = 0;
  private sessionChecked = 0;
  readonly coordinator: JobCoordinator;
  constructor(
    private store: Store,
    private market: MarketService,
    private news: NewsService,
    private analysis: AnalysisService,
    private paper: PaperService,
    private config: Config,
    private log: Logger,
  ) {
    this.coordinator = new JobCoordinator(store);
  }
  start() {
    if (!this.config.SCHEDULER_ENABLED || this.config.DATA_MODE === 'demo') return;
    const tick = () => {
      if (this.busy || this.stopped) return;
      this.busy = true;
      this.active = this.tick(Date.now())
        .catch(() => this.log.error('Scheduler cycle failed; will retry'))
        .finally(() => {
          this.busy = false;
        });
    };
    tick();
    this.timer = setInterval(tick, 5000);
  }
  async tick(now: number) {
    if (
      !this.market.session ||
      this.market.session.day !== dayKey(now) ||
      now - this.sessionChecked > 3600000
    ) {
      await this.market.loadSession(now);
      this.sessionChecked = now;
    }
    const session = this.market.session;
    if (!session?.verified || !session.trading) return;
    // The daily PREPARE job may already be DONE after restart; rebuild process-local caches and socket anyway.
    const prepareTask = sessionSchedule(session).find((t) => t.kind === 'PREPARE');
    if (prepareTask && now >= prepareTask.at && now < session.close && !this.market.isPrepared(session.day)) {
      const checkpoint = await this.store.get('data_ingestion_checkpoints', prepareTask.id);
      if (checkpoint?.status === 'DONE') {
        await this.market.prepare();
        await this.news.loadEvents();
      }
    }
    const schedule = sessionSchedule(session),
      latestDue = schedule.filter((t) => ['REEVALUATION', 'DEEP'].includes(t.kind) && t.at <= now).at(-1);
    for (const task of schedule.filter((t) => t.at <= now)) {
      const isEvaluation = ['REEVALUATION', 'DEEP'].includes(task.kind);
      const skip =
        (isEvaluation && task.id !== latestDue?.id) ||
        (now >= session.close && ['INITIAL', 'REEVALUATION', 'DEEP', 'PREMARKET'].includes(task.kind));
      const job = await this.coordinator.claim(task, now);
      if (!job) continue;
      if (skip) {
        await this.coordinator.finish(task.id, Date.now());
        continue;
      }
      const renewal = setInterval(() => {
        void this.coordinator
          .renew(task.id, Date.now())
          .catch(() => this.log.error('Job lease renewal failed'));
      }, 20000);
      try {
        if (task.kind === 'PREPARE') {
          await this.market.prepare();
          await this.news.loadEvents();
          this.news.backgroundCollect(this.market.underlyings.map((i) => i.id));
        } else if (task.kind === 'PREMARKET') {
          this.news.scheduleBriefing(atIST(session.day, '09:00'));
          await this.market.refreshContracts(Date.now());
        } else if (task.kind === 'CLOSE') {
          const unclosed = await this.paper.finalize(Date.now());
          await this.analysis.expire(Date.now());
          await this.market.reconcile(Date.now());
          for (const key of new Set(this.market.volumeKeys.values())) {
            const rows = await this.store.find('market_candles', {
              instrumentKey: key,
              interval: 1,
              start: { $gte: session.open, $lt: session.close },
            });
            await this.market.persistHistory(rows, Date.now());
          }
          await this.store.put('system_health', {
            id: 'close',
            status: unclosed.length ? 'DEGRADED' : 'OK',
            checkedAt: Date.now(),
            details: unclosed.map(
              (id) => `Unresolved paper exit ${id}: no executable quote; position retained`,
            ),
          });
        } else {
          if (!this.market.isPrepared(session.day)) throw new Error('Preparation unavailable');
          await this.market.reconcile(Date.now());
          await this.market.refreshContracts(Date.now());
          const actualNow = Date.now();
          const report = await this.analysis.evaluate(
            task.kind,
            task.at,
            actualNow,
            `${task.id}:attempt:${job.attempts}`,
          );
          const pending =
            task.kind === 'INITIAL' &&
            report.status === 'INSUFFICIENT_DATA' &&
            report.volume.length === 0 &&
            actualNow < task.at + 15 * MINUTE;
          await this.coordinator.finish(
            task.id,
            Date.now(),
            pending ? 'WAITING_FOR_COMPLETED_OPENING_DATA' : null,
            pending,
          );
          continue;
        }
        await this.coordinator.finish(task.id, Date.now());
      } catch {
        await this.coordinator.finish(task.id, Date.now(), 'JOB_FAILED_EXTERNAL_DATA_OR_STORAGE_UNAVAILABLE');
        this.log.warn({ job: task.kind }, 'Scheduled job incomplete; checkpoint saved for retry');
      } finally {
        clearInterval(renewal);
      }
    }
    const actual = Date.now();
    if (actual >= session.open && actual < session.close && this.market.isPrepared(session.day)) {
      await this.market.maintenance(actual);
      await this.analysis.expire(actual);
      if (actual - this.lastReconcile >= MINUTE) {
        await this.market.reconcile(actual);
        this.lastReconcile = actual;
      }
      if (actual - this.lastNews >= 15 * MINUTE) {
        await this.news.loadEvents(actual);
        this.news.backgroundCollect(this.market.underlyings.map((i) => i.id));
        this.lastNews = actual;
      }
      if (actual >= session.close - MINUTE) await this.paper.finalize(actual);
    }
    await this.store.put('system_health', { id: 'scheduler', status: 'OK', checkedAt: actual, details: [] });
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
