import { Inject, Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  KG_DEFAULT_TIMEZONE,
  firstOfMonthInTimezone,
} from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { tenantStorage } from '@/database/tenant-storage';
import { InvoiceService } from './invoice.service';

/**
 * BullMQ queue + repeatable job names for the monthly billing run. The
 * recurring slot is registered by `MonthlyBillingScheduler` at
 * OnApplicationBootstrap (gated by `BILLING_MONTHLY_CRON !=
 * 'disabled'`). T7a's super-admin controller pushes one-off
 * `MONTHLY_BILLING_MANUAL_JOB` jobs into the same queue for back-fill
 * and demo runs.
 *
 * Cron: `0 2 1 * *` (02:00 on day-of-month 1) in `Asia/Almaty`. BP §4
 * specifies the 1st of month as the contractual issue date for monthly
 * invoices; 02:00 keeps the job inside the lowest-traffic window.
 */
export const MONTHLY_BILLING_QUEUE = 'billing-monthly';
export const MONTHLY_BILLING_RECURRING_JOB = 'billing-monthly-recurring';
export const MONTHLY_BILLING_MANUAL_JOB = 'billing-monthly-manual';
export const MONTHLY_BILLING_CRON_EXPRESSION = '0 2 1 * *';
export const MONTHLY_BILLING_CRON_TIMEZONE = KG_DEFAULT_TIMEZONE;

/**
 * Manual job payload shape — accepted by both the cron tick (when present)
 * and the super-admin one-shot endpoint (T7a). The recurring tick supplies
 * an empty payload, and the processor falls back to "first of current
 * month in Asia/Almaty".
 */
export interface MonthlyBillingJobData {
  /**
   * ISO 8601 date string (`YYYY-MM-DD`) or full Date the caller wants
   * billed. Used by the manual super-admin trigger to back-fill or test
   * specific months without waiting for a cron tick.
   */
  periodStart?: string | Date;
}

/**
 * Per-tick summary returned by `process()` — surfaced through BullMQ's job
 * result hash so the super-admin trigger can show the counts back to the
 * operator. Mirrors the manual / cron contract: one schema for both
 * invocation paths.
 */
export interface MonthlyBillingSummary {
  /** Number of kindergartens iterated (every kg attempted). */
  kindergartensProcessed: number;
  /** Sum of invoices created across every successful per-kg run. */
  invoicesGenerated: number;
  /** Number of per-kg runs that threw — see logs for stack traces. */
  errors: number;
  /** Effective period the cron billed, ISO `YYYY-MM-DD`. */
  periodStart: string;
}

/**
 * MonthlyBillingProcessor — BullMQ worker that emits the monthly invoice
 * batch. Thin orchestration only; per-kg billing logic lives in
 * `InvoiceService.generateMonthly`.
 *
 * Flow per tick:
 *   1. Compute the effective period start. Manual jobs may pass an
 *      explicit `periodStart`; the cron leaves it empty and falls back to
 *      first-of-current-month in Asia/Almaty.
 *   2. List every active (non-archived) kindergarten via a fresh TX with
 *      `app.bypass_rls = 'true'`. The directory scan must cross every
 *      tenant — the runtime app role is NOBYPASSRLS, so without the GUC
 *      the SELECT returns zero rows.
 *   3. For each kg, open ITS OWN transaction, set
 *      `app.kindergarten_id` (NOT bypass_rls — once we know which tenant
 *      we're billing, RLS should constrain the work), publish the
 *      tenant context via `tenantStorage.run`, and call
 *      `InvoiceService.generateMonthly`. The advisory lock acquired
 *      inside the service guarantees idempotency under concurrent
 *      workers.
 *   4. Errors in one kg are caught + logged + counted. They never bubble
 *      up because each `runForKindergarten` opened its own TX — earlier
 *      kgs' commits are durable, later kgs still get a chance to run.
 *      Sequential iteration (not Promise.all) keeps the cadence simple
 *      and avoids competing for advisory locks across the same period.
 *
 * GUC isolation: cross-tenant kg listing MUST happen in its own TX
 * (B10 T7-2 HIGH#2 lesson — `SET LOCAL` leaks to the ambient TX
 * otherwise, leaving downstream queries with `app.bypass_rls=true` and
 * silently exposing every tenant's data). Each per-kg run opens a fresh
 * TX so the kg-scoped GUC is released at COMMIT.
 */
@Processor(MONTHLY_BILLING_QUEUE)
export class MonthlyBillingProcessor extends WorkerHost {
  private readonly logger = new Logger(MonthlyBillingProcessor.name);

  constructor(
    private readonly invoiceService: InvoiceService,
    private readonly dataSource: DataSource,
    // SP1 (FINDINGS): explicit `@Inject(ClockPort)` so the worker process
    // resolves the abstract port via reflect-metadata (BullMQ workers boot
    // under a different DI graph and can otherwise see `undefined` for
    // abstract-class tokens).
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(
    job: Job<MonthlyBillingJobData>,
  ): Promise<MonthlyBillingSummary> {
    if (
      job.name !== MONTHLY_BILLING_RECURRING_JOB &&
      job.name !== MONTHLY_BILLING_MANUAL_JOB
    ) {
      // Future jobs on the same queue may exist; the processor only owns
      // the two known job names and silently ignores the rest.
      return {
        kindergartensProcessed: 0,
        invoicesGenerated: 0,
        errors: 0,
        periodStart: '',
      };
    }

    const periodStart = this.computePeriodStart(job.data?.periodStart);
    const periodIso = isoDate(periodStart);
    this.logger.log(
      `monthly-billing tick start: job=${job.name} periodStart=${periodIso}`,
    );

    const kgIds = await this.listAllKindergartens();
    this.logger.log(
      `monthly-billing: ${kgIds.length} active kindergartens to process`,
    );

    let invoicesGenerated = 0;
    let errors = 0;

    // Sequential — not Promise.all. Each kg opens its own TX (so its
    // advisory lock is held only for its own work) but processing kg N+1
    // before N commits would needlessly contend for the worker's pool
    // connections. The advisory lock per (kg, period) inside
    // `InvoiceService.generateMonthly` already prevents duplicate work
    // across multiple worker processes; sequential iteration keeps the
    // single-process loop simple.
    for (const kgId of kgIds) {
      try {
        const result = await this.runForKindergarten(kgId, periodStart);
        invoicesGenerated += result.generated;
      } catch (err) {
        errors += 1;
        const stack = err instanceof Error ? err.stack : String(err);
        this.logger.error(
          `monthly-billing: kg=${kgId} period=${periodIso} failed`,
          stack,
        );
        // Per-kg isolation. Each runForKindergarten opens its own TX, so
        // the failure has already rolled back the bad kg's writes. The
        // outer loop continues so a single misconfigured kg does not
        // block the rest of the batch.
      }
    }

    const summary: MonthlyBillingSummary = {
      kindergartensProcessed: kgIds.length,
      invoicesGenerated,
      errors,
      periodStart: periodIso,
    };
    this.logger.log(
      `monthly-billing tick summary: kgs=${summary.kindergartensProcessed} invoices=${summary.invoicesGenerated} errors=${summary.errors} period=${summary.periodStart}`,
    );
    return summary;
  }

  /**
   * Run a single kindergarten's monthly invoice generation. Opens a
   * fresh TX, sets the kg-scoped RLS GUC (so any incidental cross-table
   * queries done by `InvoiceService` see only that kg's rows), and
   * publishes the tenant context via `tenantStorage.run` so every
   * `manager()` helper inside repositories resolves to the per-tx
   * EntityManager.
   *
   * Exposed (not `private`) so the integration race spec can drive it
   * directly without going through BullMQ.
   */
  async runForKindergarten(
    kgId: string,
    periodStart: Date,
  ): Promise<{ generated: number; skipped: number }> {
    return this.dataSource.transaction(async (em) => {
      // Use `set_config(key, value, true)` — `is_local=true` matches
      // `SET LOCAL` semantics (released at COMMIT), and the parameter
      // form is safe against quoting issues with UUID input.
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run({ kgId, bypass: false, entityManager: em }, () =>
        this.invoiceService.generateMonthly(kgId, periodStart),
      );
    });
  }

  /**
   * Cross-tenant directory scan. Uses a fresh TX with `bypass_rls=true`
   * — the runtime app role is NOBYPASSRLS, so without this GUC every
   * tenant-scoped SELECT returns zero rows. The TX commits immediately
   * after the SELECT, releasing the bypass GUC before any per-kg work
   * begins; per-kg work opens its own TX where RLS is correctly scoped.
   *
   * `archived_at IS NULL` filters tenants archived via
   * `KindergartenService.archive` (B12 BP §6 soft-delete semantics).
   */
  private async listAllKindergartens(): Promise<string[]> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const rows = (await em.query(
        `SELECT id FROM kindergartens WHERE archived_at IS NULL ORDER BY id`,
      )) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    });
  }

  /**
   * Resolve the effective `periodStart`. Manual job payloads may pass
   * an explicit override (string ISO date or `Date`); the cron tick
   * leaves `job.data` empty and we default to the first day of the
   * current month in `Asia/Almaty`.
   *
   * The returned `Date` is at UTC midnight of the chosen YMD so
   * downstream date-only persistence (PG `date` column) round-trips
   * cleanly without timezone drift.
   */
  computePeriodStart(jobData?: string | Date): Date {
    if (jobData !== undefined && jobData !== null) {
      const parsed = jobData instanceof Date ? jobData : new Date(jobData);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(
          `monthly-billing: invalid periodStart payload: ${String(jobData)}`,
        );
      }
      return firstOfMonthUtc(parsed);
    }
    const now = this.clock.now();
    return firstOfMonthInTimezone(now, MONTHLY_BILLING_CRON_TIMEZONE);
  }
}

// ── pure date helpers ─────────────────────────────────────────────────────

/**
 * UTC-only first-of-month — used ONLY when the caller already pinned an
 * explicit `periodStart` payload (manual back-fill jobs), where the input
 * is interpreted at face value. For cron ticks we use
 * `firstOfMonthInTimezone` from shared-kernel so the Almaty calendar
 * decides the period boundary.
 */
function firstOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
