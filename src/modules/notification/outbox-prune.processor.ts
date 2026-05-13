import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { KG_DEFAULT_TIMEZONE } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { tenantStorage } from '@/database/tenant-storage';
import { OutboxEventRepository } from './outbox-event.repository';

/**
 * BullMQ queue + repeatable job names for the B22b T12 weekly
 * notification-outbox prune cron.
 *
 * Cron: `0 4 * * 0` — Sunday at 04:00 Asia/Almaty. Picks a quiet window
 * an hour after the other 03:00 crons (monthly-billing, discount-expire,
 * overdue-invoice) so they never share a connection-pool slot with the
 * pruner's cross-tenant DELETE.
 *
 * The processor:
 *   1. Reads `now` from `ClockPort` (manual jobs may pass an override
 *      via the job payload; same idiom as `OverdueInvoiceProcessor`).
 *   2. Opens ONE bypass-RLS transaction (cross-tenant — the prune is an
 *      admin-level housekeeping job, not a per-kg operation). The
 *      outbox table is RLS-policied with FORCE ROW LEVEL SECURITY so a
 *      non-bypass DELETE would only see the (zero) current tenant rows
 *      and silently no-op.
 *   3. Calls `OutboxEventRepository.prunePrunables(cutoffs...)` which
 *      runs two `DELETE … WHERE status = ... AND created_at < cutoff`
 *      statements backed by the partial indexes added in
 *      `1778650000000-B22OutboxPruneIndex` (one per terminal status).
 *
 * Retention windows (hardcoded — operationally we never want to vary
 * these per deploy and a misconfigured env-knob is more dangerous than
 * a hardcoded one; revisit when GDPR/compliance pushes us):
 *   - `dispatched` rows: 7 days. Just long enough for a "did this fire
 *     last week?" audit query.
 *   - `failed` rows: 30 days. Longer so post-incident review can read
 *     the `failed_reason` before it's pruned. After 30d the row is
 *     considered fossilised — `MAX_OUTBOX_ATTEMPTS` is exhausted and
 *     the dispatcher will never retry it.
 *
 * Idempotent: re-running the same tick deletes only newly-stale rows
 * because the cutoff anchors on `now()`. Concurrent ticks are barred
 * by BullMQ's per-worker `concurrency=1` default.
 */
export const OUTBOX_PRUNE_QUEUE = 'notifications-outbox-prune';
export const OUTBOX_PRUNE_RECURRING_JOB =
  'notifications-outbox-prune-recurring';
export const OUTBOX_PRUNE_MANUAL_JOB = 'notifications-outbox-prune-manual';
export const OUTBOX_PRUNE_CRON_EXPRESSION = '0 4 * * 0';
export const OUTBOX_PRUNE_CRON_TIMEZONE = KG_DEFAULT_TIMEZONE;
export const OUTBOX_PRUNE_SCHEDULER_ID = 'notifications-outbox-prune-cron';

/** 7 days in milliseconds — `dispatched` retention horizon. */
export const OUTBOX_PRUNE_DISPATCHED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 30 days in milliseconds — `failed` retention horizon. */
export const OUTBOX_PRUNE_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface OutboxPruneJobData {
  /**
   * ISO-8601 timestamp the operator wants to anchor the cutoff against.
   * Manual jobs may pass an override (e.g. for back-fill or testing);
   * the recurring tick leaves it empty and we fall through to
   * `clock.now()`.
   */
  now?: string | Date;
}

export interface OutboxPruneSummary {
  /** Count of `status='dispatched'` rows deleted. */
  deletedDispatched: number;
  /** Count of `status='failed'` rows deleted. */
  deletedFailed: number;
  /** ISO-8601 timestamp of the effective `now` used for the run. */
  now: string;
  /** ISO-8601 timestamp of the `dispatched` cutoff (now - 7d). */
  dispatchedCutoff: string;
  /** ISO-8601 timestamp of the `failed` cutoff (now - 30d). */
  failedCutoff: string;
}

@Processor(OUTBOX_PRUNE_QUEUE)
export class OutboxPruneProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxPruneProcessor.name);

  constructor(
    private readonly outboxRepo: OutboxEventRepository,
    private readonly dataSource: DataSource,
    // Explicit `@Inject(ClockPort)` — the worker process resolves the
    // abstract-class port via reflect-metadata and the BullMQ worker DI
    // graph would otherwise see `undefined`. Same idiom as the other
    // B22a T3 SP1 processors.
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(job: Job<OutboxPruneJobData>): Promise<OutboxPruneSummary> {
    if (
      job.name !== OUTBOX_PRUNE_RECURRING_JOB &&
      job.name !== OUTBOX_PRUNE_MANUAL_JOB
    ) {
      return {
        deletedDispatched: 0,
        deletedFailed: 0,
        now: '',
        dispatchedCutoff: '',
        failedCutoff: '',
      };
    }

    const now = this.computeNow(job.data?.now);
    const dispatchedCutoff = new Date(
      now.getTime() - OUTBOX_PRUNE_DISPATCHED_RETENTION_MS,
    );
    const failedCutoff = new Date(
      now.getTime() - OUTBOX_PRUNE_FAILED_RETENTION_MS,
    );
    const summary = await this.run(now, dispatchedCutoff, failedCutoff);
    this.logger.log(
      `outbox-prune tick: now=${summary.now} ` +
        `deletedDispatched=${summary.deletedDispatched} ` +
        `(cutoff=${summary.dispatchedCutoff}) ` +
        `deletedFailed=${summary.deletedFailed} ` +
        `(cutoff=${summary.failedCutoff})`,
    );
    return summary;
  }

  /**
   * Cross-tenant DELETE under `app.bypass_rls = 'true'`. Exposed (not
   * private) so the integration spec can drive it directly without
   * BullMQ transport. The bypass GUC lives only for the lifetime of
   * this transaction — when it commits the next pool checkout returns
   * to non-bypass scope.
   */
  async run(
    now: Date,
    dispatchedCutoff: Date,
    failedCutoff: Date,
  ): Promise<OutboxPruneSummary> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SET LOCAL app.bypass_rls = 'true'`);
      return tenantStorage.run(
        { kgId: null, bypass: true, entityManager: em },
        async () => {
          const result = await this.outboxRepo.prunePrunables(
            em,
            dispatchedCutoff,
            failedCutoff,
          );
          return {
            deletedDispatched: result.deletedDispatched,
            deletedFailed: result.deletedFailed,
            now: now.toISOString(),
            dispatchedCutoff: dispatchedCutoff.toISOString(),
            failedCutoff: failedCutoff.toISOString(),
          };
        },
      );
    });
  }

  computeNow(jobData?: string | Date): Date {
    if (jobData !== undefined && jobData !== null) {
      const parsed = jobData instanceof Date ? jobData : new Date(jobData);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(
          `outbox-prune: invalid now payload: ${String(jobData)}`,
        );
      }
      return parsed;
    }
    return this.clock.now();
  }
}

/**
 * OutboxPruneScheduler — registers the BullMQ repeatable job at
 * application bootstrap. Mirrors the gating + graceful-failure
 * semantics of `OverdueInvoiceScheduler` and the other B22a cron
 * schedulers. Gated by `OUTBOX_PRUNE_CRON !== 'disabled'` (default
 * enabled). API-side processes can opt out by setting
 * `OUTBOX_PRUNE_CRON=disabled` to leave the recurring tick to the
 * worker process.
 */
@Injectable()
export class OutboxPruneScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(OutboxPruneScheduler.name);

  constructor(
    @Optional()
    @InjectQueue(OUTBOX_PRUNE_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const flag = (process.env.OUTBOX_PRUNE_CRON ?? 'enabled').toLowerCase();
    if (flag === 'disabled') {
      this.logger.log(
        'outbox-prune scheduler skipped (OUTBOX_PRUNE_CRON=disabled)',
      );
      return;
    }
    if (!this.queue) {
      this.logger.warn(
        'outbox-prune scheduler skipped — BullMQ queue not provided',
      );
      return;
    }
    try {
      await this.queue.upsertJobScheduler(
        OUTBOX_PRUNE_SCHEDULER_ID,
        {
          pattern: OUTBOX_PRUNE_CRON_EXPRESSION,
          tz: OUTBOX_PRUNE_CRON_TIMEZONE,
        },
        {
          name: OUTBOX_PRUNE_RECURRING_JOB,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          },
        },
      );
      this.logger.log(
        `outbox-prune scheduler upserted (pattern=${OUTBOX_PRUNE_CRON_EXPRESSION} tz=${OUTBOX_PRUNE_CRON_TIMEZONE})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `outbox-prune scheduler upsert failed: ${msg} — continuing without recurring job`,
      );
    }
  }
}
