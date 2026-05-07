import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MONTHLY_BILLING_CRON_EXPRESSION,
  MONTHLY_BILLING_CRON_TIMEZONE,
  MONTHLY_BILLING_QUEUE,
  MONTHLY_BILLING_RECURRING_JOB,
} from './monthly-billing.processor';

/**
 * Scheduler-id for the monthly billing recurring job. Stable across
 * restarts — `upsertJobScheduler` deduplicates on this id, so re-booting
 * the worker will refresh the existing record in place rather than
 * creating duplicates in Redis. T7a's manual super-admin trigger uses a
 * different `MONTHLY_BILLING_MANUAL_JOB` job name so its one-shot pushes
 * never collide with this recurring scheduler.
 */
export const MONTHLY_BILLING_SCHEDULER_ID = 'billing-monthly-cron';

/**
 * MonthlyBillingScheduler — registers the BullMQ repeatable job that
 * fires `InvoiceService.generateMonthly` on the 1st of every month at
 * 02:00 Asia/Almaty.
 *
 * Why a separate provider instead of inlining into the processor:
 *   - The processor is registered in both api and worker process trees
 *     (it's part of `BillingModule`). The cron only needs to be upserted
 *     once. Gating the upsert here on a single env flag keeps the
 *     registration single-source-of-truth without the api process
 *     redundantly contending for the same Redis hash key.
 *
 * Activation contract:
 *   - Default: registered when `BILLING_MONTHLY_CRON !== 'disabled'`.
 *   - Set `BILLING_MONTHLY_CRON=disabled` for the api process (and unit
 *     tests / e2e suites that boot the full `AppModule` without a Redis
 *     reachable on localhost).
 *   - Set `BILLING_MONTHLY_CRON=enabled` (or leave unset) when running
 *     the worker process (`npm run start:worker`).
 *
 * Idempotency:
 *   - `upsertJobScheduler` is idempotent on `MONTHLY_BILLING_SCHEDULER_ID`.
 *     Multiple workers re-running this hook converge on a single
 *     scheduler record in Redis. BullMQ then claims each tick from one
 *     worker only — distributed-lock-free.
 *
 * Failure mode:
 *   - If Redis is unreachable at boot the upsert call rejects. We log
 *     the error and let bootstrap continue so the api / worker start
 *     even when the cron is wedged. T7a's manual trigger remains
 *     available for operators to recover by hand.
 */
@Injectable()
export class MonthlyBillingScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(MonthlyBillingScheduler.name);

  constructor(
    @Optional()
    @InjectQueue(MONTHLY_BILLING_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const flag = (process.env.BILLING_MONTHLY_CRON ?? 'enabled').toLowerCase();
    if (flag === 'disabled') {
      this.logger.log(
        'monthly-billing scheduler skipped (BILLING_MONTHLY_CRON=disabled)',
      );
      return;
    }
    if (!this.queue) {
      // BullModule.registerQueue is part of BillingModule, but the
      // optional injection guards against test-bed contexts that override
      // the queue token. Surfacing as a warn (not an error) keeps such
      // tests bootable without forcing them to stub Redis.
      this.logger.warn(
        'monthly-billing scheduler skipped — BullMQ queue not provided',
      );
      return;
    }
    try {
      // attempts=3 + exponential backoff (60s base) handles transient
      // infra blips at the 02:00 tick — same philosophy as
      // `WorkerJobSchedulerService.weekly-rollout-cron`. Without retries
      // a single failed attempt would leave that month un-billed until
      // the next cron fires (+1 month).
      await this.queue.upsertJobScheduler(
        MONTHLY_BILLING_SCHEDULER_ID,
        {
          pattern: MONTHLY_BILLING_CRON_EXPRESSION,
          tz: MONTHLY_BILLING_CRON_TIMEZONE,
        },
        {
          name: MONTHLY_BILLING_RECURRING_JOB,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          },
        },
      );
      this.logger.log(
        `monthly-billing scheduler upserted (pattern=${MONTHLY_BILLING_CRON_EXPRESSION} tz=${MONTHLY_BILLING_CRON_TIMEZONE})`,
      );
    } catch (err) {
      // Bootstrap failure here would block the entire process from
      // starting (api or worker). The cron is recoverable via the
      // manual super-admin trigger, so we log + swallow rather than
      // propagate. Operators see the warning in startup logs and can
      // re-bootstrap once Redis is reachable.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `monthly-billing scheduler upsert failed: ${msg} — continuing without recurring job`,
      );
    }
  }
}
