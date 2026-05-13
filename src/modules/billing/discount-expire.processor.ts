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
import { CustomDiscountService } from './custom-discount.service';

/**
 * BullMQ queue + repeatable job for the B16 discount-expire run.
 *
 * Cron: `0 3 * * *` — daily at 03:00 Asia/Almaty (one hour after the
 * monthly billing cron so the two never contend for the same per-kg
 * advisory locks). Repeatable schedule is registered by
 * `DiscountExpireScheduler` at OnApplicationBootstrap (gated by
 * `BILLING_DISCOUNT_EXPIRE_CRON != 'disabled'`).
 *
 * BP §4.1: `active → expired` transition is silent (no notification
 * emit). The processor's only side-effects are:
 *   1. UPDATE custom_discounts SET status='expired' WHERE valid_until <= now
 *   2. Log the per-kg expiry counts for ops visibility.
 */
export const DISCOUNT_EXPIRE_QUEUE = 'billing-discount-expire';
export const DISCOUNT_EXPIRE_RECURRING_JOB =
  'billing-discount-expire-recurring';
export const DISCOUNT_EXPIRE_MANUAL_JOB = 'billing-discount-expire-manual';
export const DISCOUNT_EXPIRE_CRON_EXPRESSION = '0 3 * * *';
export const DISCOUNT_EXPIRE_CRON_TIMEZONE = KG_DEFAULT_TIMEZONE;
export const DISCOUNT_EXPIRE_SCHEDULER_ID = 'billing-discount-expire-cron';

export interface DiscountExpireJobData {
  /**
   * ISO-8601 timestamp the operator wants to anchor expiration against.
   * Manual jobs may pass an override (e.g. for testing); the recurring
   * tick leaves it empty and we fall through to `clock.now()`.
   */
  now?: string | Date;
}

export interface DiscountExpireSummary {
  kindergartensProcessed: number;
  discountsExpired: number;
  errors: number;
  /** ISO-8601 timestamp of the effective `now` used for the run. */
  now: string;
}

/**
 * Processor — iterates every active kg under `bypass_rls=true`, opens a
 * fresh per-kg TX with the kg-scoped GUC, and calls
 * `CustomDiscountService.expireOverdue`. Per-kg failures are caught +
 * counted; the loop continues so a single misconfigured kg can't block
 * the rest of the batch.
 *
 * Idempotent: `expireOverdue` runs a single conditional UPDATE
 * (`WHERE status='active' AND valid_until <= now`) — re-running the
 * cron picks up only newly-overdue rows.
 */
@Processor(DISCOUNT_EXPIRE_QUEUE)
export class DiscountExpireProcessor extends WorkerHost {
  private readonly logger = new Logger(DiscountExpireProcessor.name);

  constructor(
    private readonly customDiscountService: CustomDiscountService,
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
    job: Job<DiscountExpireJobData>,
  ): Promise<DiscountExpireSummary> {
    if (
      job.name !== DISCOUNT_EXPIRE_RECURRING_JOB &&
      job.name !== DISCOUNT_EXPIRE_MANUAL_JOB
    ) {
      return {
        kindergartensProcessed: 0,
        discountsExpired: 0,
        errors: 0,
        now: '',
      };
    }
    const now = this.computeNow(job.data?.now);
    const nowIso = now.toISOString();
    this.logger.log(
      `discount-expire tick start: job=${job.name} now=${nowIso}`,
    );

    const kgIds = await this.listAllKindergartens();
    this.logger.log(
      `discount-expire: ${kgIds.length} active kindergartens to process`,
    );

    let discountsExpired = 0;
    let errors = 0;
    for (const kgId of kgIds) {
      try {
        const result = await this.runForKindergarten(kgId, now);
        discountsExpired += result.expiredIds.length;
      } catch (err) {
        errors += 1;
        const stack = err instanceof Error ? err.stack : String(err);
        this.logger.error(
          `discount-expire: kg=${kgId} now=${nowIso} failed`,
          stack,
        );
      }
    }
    const summary: DiscountExpireSummary = {
      kindergartensProcessed: kgIds.length,
      discountsExpired,
      errors,
      now: nowIso,
    };
    this.logger.log(
      `discount-expire tick summary: kgs=${summary.kindergartensProcessed} expired=${summary.discountsExpired} errors=${summary.errors} now=${summary.now}`,
    );
    return summary;
  }

  /**
   * Per-kg run. Fresh TX with kg-scoped GUC + tenantStorage publish so
   * `CustomDiscountRepository` repos resolve their EM via tenantStorage
   * and write under RLS scope. Exposed (not private) so the integration
   * spec can drive it directly without going through BullMQ.
   */
  async runForKindergarten(
    kgId: string,
    now: Date,
  ): Promise<{ expiredIds: string[] }> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run({ kgId, bypass: false, entityManager: em }, () =>
        this.customDiscountService.expireOverdue(kgId, now),
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

  private computeNow(jobData?: string | Date): Date {
    if (jobData !== undefined && jobData !== null) {
      const parsed = jobData instanceof Date ? jobData : new Date(jobData);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(
          `discount-expire: invalid now payload: ${String(jobData)}`,
        );
      }
      return parsed;
    }
    return this.clock.now();
  }
}

/**
 * DiscountExpireScheduler — registers the BullMQ repeatable job at
 * application bootstrap. Mirrors `MonthlyBillingScheduler`'s gating,
 * idempotency, and graceful-failure semantics.
 */
@Injectable()
export class DiscountExpireScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(DiscountExpireScheduler.name);

  constructor(
    @Optional()
    @InjectQueue(DISCOUNT_EXPIRE_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const flag = (
      process.env.BILLING_DISCOUNT_EXPIRE_CRON ?? 'enabled'
    ).toLowerCase();
    if (flag === 'disabled') {
      this.logger.log(
        'discount-expire scheduler skipped (BILLING_DISCOUNT_EXPIRE_CRON=disabled)',
      );
      return;
    }
    if (!this.queue) {
      this.logger.warn(
        'discount-expire scheduler skipped — BullMQ queue not provided',
      );
      return;
    }
    try {
      await this.queue.upsertJobScheduler(
        DISCOUNT_EXPIRE_SCHEDULER_ID,
        {
          pattern: DISCOUNT_EXPIRE_CRON_EXPRESSION,
          tz: DISCOUNT_EXPIRE_CRON_TIMEZONE,
        },
        {
          name: DISCOUNT_EXPIRE_RECURRING_JOB,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          },
        },
      );
      this.logger.log(
        `discount-expire scheduler upserted (pattern=${DISCOUNT_EXPIRE_CRON_EXPRESSION} tz=${DISCOUNT_EXPIRE_CRON_TIMEZONE})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `discount-expire scheduler upsert failed: ${msg} — continuing without recurring job`,
      );
    }
  }
}
