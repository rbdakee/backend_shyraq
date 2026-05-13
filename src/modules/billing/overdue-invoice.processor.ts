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
import { NotificationPort } from '@/common/notifications/notification.port';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  formatDateInTimezone,
  KG_DEFAULT_TIMEZONE,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { tenantStorage } from '@/database/tenant-storage';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';

/**
 * BullMQ queue + repeatable job names for the B22a T1 nightly overdue
 * invoice cron.
 *
 * Cron: `0 3 * * *` — daily at 03:00 Asia/Almaty. Same hour-after-monthly
 * pattern as `DiscountExpireProcessor` so the three crons (monthly @ 02,
 * overdue @ 03, discount-expire @ 03) never contend for the same per-kg
 * advisory locks (overdue + discount-expire on different tables, but
 * sharing the worker connection pool — sequencing them an hour apart
 * keeps the schedule readable).
 *
 * The processor:
 *   1. iterates every active (non-archived) kindergarten under
 *      `app.bypass_rls = 'true'` (B10 H#2 cross-tenant scan pattern),
 *   2. for each kg opens its own TX with `app.kindergarten_id` set,
 *   3. calls `InvoiceRepository.markOverdueBatch(kg, now)` — single
 *      conditional UPDATE that flips `(pending|partial) → overdue` for
 *      rows whose `due_date < now::date` and returns the flipped IDs,
 *   4. for each newly-flipped row emits an `invoice.overdue` outbox
 *      event in the SAME ambient TX (atomic with the status flip).
 *
 * Idempotent: re-running the same tick is a no-op because the status
 * filter `WHERE status IN ('pending', 'partial')` excludes rows already
 * in `overdue`. The `daysOverdue` per event is computed from
 * `(now - due_date)` at flip time so a later re-run does not re-emit a
 * different "days" count.
 */
export const OVERDUE_INVOICE_QUEUE = 'billing-overdue';
export const OVERDUE_INVOICE_RECURRING_JOB = 'billing-overdue-recurring';
export const OVERDUE_INVOICE_MANUAL_JOB = 'billing-overdue-manual';
export const OVERDUE_INVOICE_CRON_EXPRESSION = '0 3 * * *';
export const OVERDUE_INVOICE_CRON_TIMEZONE = KG_DEFAULT_TIMEZONE;
export const OVERDUE_INVOICE_SCHEDULER_ID = 'billing-overdue-cron';

export interface OverdueInvoiceJobData {
  /**
   * ISO-8601 timestamp the operator wants to anchor the overdue cut-off
   * against. Manual jobs may pass an override (back-fill / demo); the
   * recurring tick leaves it empty and we fall through to
   * `clock.now()`.
   */
  now?: string | Date;
}

export interface OverdueInvoiceSummary {
  kindergartensProcessed: number;
  invoicesFlipped: number;
  errors: number;
  /** ISO-8601 timestamp of the effective `now` used for the run. */
  now: string;
}

/**
 * Processor — see class-level docstring on
 * `MonthlyBillingProcessor`/`DiscountExpireProcessor` for the
 * iteration pattern; this processor mirrors them.
 *
 * SP1 follow-on: `@Inject(ClockPort)` carries the clock via DI so test
 * harnesses can substitute a `FixedClock` without monkey-patching the
 * processor.
 */
@Processor(OVERDUE_INVOICE_QUEUE)
export class OverdueInvoiceProcessor extends WorkerHost {
  private readonly logger = new Logger(OverdueInvoiceProcessor.name);

  constructor(
    private readonly invoiceRepo: InvoiceRepository,
    private readonly notificationPort: NotificationPort,
    private readonly dataSource: DataSource,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(
    job: Job<OverdueInvoiceJobData>,
  ): Promise<OverdueInvoiceSummary> {
    if (
      job.name !== OVERDUE_INVOICE_RECURRING_JOB &&
      job.name !== OVERDUE_INVOICE_MANUAL_JOB
    ) {
      return {
        kindergartensProcessed: 0,
        invoicesFlipped: 0,
        errors: 0,
        now: '',
      };
    }

    const now = this.computeNow(job.data?.now);
    const nowIso = now.toISOString();
    this.logger.log(
      `overdue-invoice tick start: job=${job.name} now=${nowIso}`,
    );

    const kgIds = await this.listAllKindergartens();
    this.logger.log(
      `overdue-invoice: ${kgIds.length} active kindergartens to process`,
    );

    let invoicesFlipped = 0;
    let errors = 0;

    for (const kgId of kgIds) {
      try {
        const result = await this.runForKindergarten(kgId, now);
        invoicesFlipped += result.flippedIds.length;
      } catch (err) {
        errors += 1;
        const stack = err instanceof Error ? err.stack : String(err);
        this.logger.error(
          `overdue-invoice: kg=${kgId} now=${nowIso} failed`,
          stack,
        );
      }
    }

    const summary: OverdueInvoiceSummary = {
      kindergartensProcessed: kgIds.length,
      invoicesFlipped,
      errors,
      now: nowIso,
    };
    this.logger.log(
      `overdue-invoice tick summary: kgs=${summary.kindergartensProcessed} flipped=${summary.invoicesFlipped} errors=${summary.errors} now=${summary.now}`,
    );
    return summary;
  }

  /**
   * Per-kg run. Fresh TX with kg-scoped GUC + tenantStorage publish so
   * the relational repo's manager() resolves to the per-tx EntityManager
   * (RLS scoped). Exposed (not private) so e2e + integration specs can
   * drive it directly without BullMQ transport.
   *
   * B22a T13:
   *   - M5 (opus): acquires `billing:overdue:<kg>:<YYYY-MM-DD>` advisory
   *     lock at the top of the per-kg TX. Held until COMMIT/ROLLBACK so
   *     a concurrent manual saas trigger or a re-run of the recurring
   *     job cannot double-emit `invoice.overdue` notifications for rows
   *     a sibling tick already flipped.
   *   - M1 (codex): the cut-off date is computed in JS as
   *     `formatDateInTimezone(now, 'Asia/Almaty')` and forwarded to the
   *     repo. Earlier the repo cast `now::date` in the DB session
   *     timezone (typically UTC) so a 03:00 Almaty cron tick still saw
   *     "yesterday" and silently skipped invoices due that local day.
   */
  async runForKindergarten(
    kgId: string,
    now: Date,
  ): Promise<{ flippedIds: string[] }> {
    const today = formatDateInTimezone(now, KG_DEFAULT_TIMEZONE);
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run(
        { kgId, bypass: false, entityManager: em },
        async () => {
          await this.invoiceRepo.acquireOverdueRunAdvisoryLock(kgId, today);
          const flipped = await this.invoiceRepo.markOverdueBatch(
            kgId,
            today,
            now,
          );
          for (const row of flipped) {
            const daysOverdue = computeDaysOverdue(row.dueDate, now);
            await this.notificationPort.notifyInvoiceOverdue({
              kindergartenId: kgId,
              invoiceId: row.id,
              childId: row.childId,
              amountAfterDiscount: row.amountAfterDiscount,
              dueDate: row.dueDate,
              daysOverdue,
            });
          }
          return { flippedIds: flipped.map((r) => r.id) };
        },
      );
    });
  }

  private async listAllKindergartens(): Promise<string[]> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const rows = (await em.query(
        `SELECT id FROM kindergartens WHERE archived_at IS NULL ORDER BY id`,
      )) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    });
  }

  computeNow(jobData?: string | Date): Date {
    if (jobData !== undefined && jobData !== null) {
      const parsed = jobData instanceof Date ? jobData : new Date(jobData);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(
          `overdue-invoice: invalid now payload: ${String(jobData)}`,
        );
      }
      return parsed;
    }
    return this.clock.now();
  }
}

/**
 * OverdueInvoiceScheduler — registers the BullMQ repeatable job at
 * application bootstrap. Mirrors `MonthlyBillingScheduler` +
 * `DiscountExpireScheduler` gating, idempotency, and graceful-failure
 * semantics. Gated by `BILLING_OVERDUE_CRON !== 'disabled'`.
 */
@Injectable()
export class OverdueInvoiceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(OverdueInvoiceScheduler.name);

  constructor(
    @Optional()
    @InjectQueue(OVERDUE_INVOICE_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const flag = (process.env.BILLING_OVERDUE_CRON ?? 'enabled').toLowerCase();
    if (flag === 'disabled') {
      this.logger.log(
        'overdue-invoice scheduler skipped (BILLING_OVERDUE_CRON=disabled)',
      );
      return;
    }
    if (!this.queue) {
      this.logger.warn(
        'overdue-invoice scheduler skipped — BullMQ queue not provided',
      );
      return;
    }
    try {
      await this.queue.upsertJobScheduler(
        OVERDUE_INVOICE_SCHEDULER_ID,
        {
          pattern: OVERDUE_INVOICE_CRON_EXPRESSION,
          tz: OVERDUE_INVOICE_CRON_TIMEZONE,
        },
        {
          name: OVERDUE_INVOICE_RECURRING_JOB,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          },
        },
      );
      this.logger.log(
        `overdue-invoice scheduler upserted (pattern=${OVERDUE_INVOICE_CRON_EXPRESSION} tz=${OVERDUE_INVOICE_CRON_TIMEZONE})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `overdue-invoice scheduler upsert failed: ${msg} — continuing without recurring job`,
      );
    }
  }
}

/**
 * Days between `dueDate` (YYYY-MM-DD) and `now` (UTC). Computes the
 * floor of the day difference, i.e. an invoice due 2026-05-12 evaluated
 * at 2026-05-13T03:00 Almaty reports `daysOverdue = 1` (one full
 * calendar day past due). Uses UTC math; cron tz is enforced at the
 * BullMQ scheduler level so cron ticks fire at the intended local
 * window — the dueDate comparison itself is timezone-agnostic.
 */
function computeDaysOverdue(dueDateIso: string, now: Date): number {
  const due = new Date(`${dueDateIso}T00:00:00.000Z`);
  const dayDiff = Math.floor(
    (now.getTime() - due.getTime()) / (24 * 60 * 60 * 1000),
  );
  return Math.max(0, dayDiff);
}
