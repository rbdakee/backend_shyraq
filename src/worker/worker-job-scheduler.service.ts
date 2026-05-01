import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  OUTBOX_POLLER_JOB,
  OUTBOX_POLLER_QUEUE,
} from '@/modules/notification/outbox-poller.processor';
import {
  WEEKLY_ROLLOUT_CRON_EXPRESSION,
  WEEKLY_ROLLOUT_CRON_TIMEZONE,
  WEEKLY_ROLLOUT_JOB,
  WEEKLY_ROLLOUT_QUEUE,
} from '@/modules/schedule-rollout/weekly-rollout.processor';

/**
 * Polling cadence for the outbox drain. 2 seconds is small enough that
 * end-user latency stays under one human-perceptible "moment", while large
 * enough that a backlog-empty Redis sees only ~30 SELECTs/min from the
 * worker. Tied to BullMQ via `every` instead of a cron pattern because
 * sub-minute cron is non-portable.
 */
export const OUTBOX_POLL_INTERVAL_MS = 2_000;

/**
 * WorkerJobSchedulerService — registers the worker process's repeatable
 * BullMQ jobs at boot. `upsertJobScheduler` is idempotent: re-calling it on
 * every restart with the same scheduler-id and `repeat` opts updates the
 * existing record in place (or creates one if missing). That keeps the
 * worker's state in Redis canonical without manual cleanup.
 *
 * Two schedulers:
 *   - `outbox-poller`     → drain `notification_outbox` every 2 seconds.
 *   - `weekly-rollout`    → fire Sundays 23:00 Asia/Almaty.
 *
 * Both run inside the worker process only. The api process never imports
 * `WorkerModule` and never enqueues onto these queues, so the cadence is
 * single-source-of-truth here.
 */
@Injectable()
export class WorkerJobSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(WorkerJobSchedulerService.name);

  constructor(
    @InjectQueue(OUTBOX_POLLER_QUEUE)
    private readonly outboxQueue: Queue,
    @InjectQueue(WEEKLY_ROLLOUT_QUEUE)
    private readonly rolloutQueue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    // Outbox poller — every 2s, named so future fan-out jobs on the same
    // queue can coexist.
    await this.outboxQueue.upsertJobScheduler(
      'outbox-poller',
      { every: OUTBOX_POLL_INTERVAL_MS },
      {
        name: OUTBOX_POLLER_JOB,
        opts: {
          // Keep a small history so a dead worker is detectable from
          // outside — avoid unbounded growth of Redis hash entries.
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      },
    );
    this.logger.log(
      `outbox poller scheduler upserted (every=${OUTBOX_POLL_INTERVAL_MS}ms)`,
    );

    // Weekly rollout — Sunday 23:00 Asia/Almaty. Cron pattern + tz are the
    // exact pair the previous @nestjs/schedule decoration used so the
    // operational contract (BP §9.3) is unchanged.
    await this.rolloutQueue.upsertJobScheduler(
      'weekly-rollout-cron',
      {
        pattern: WEEKLY_ROLLOUT_CRON_EXPRESSION,
        tz: WEEKLY_ROLLOUT_CRON_TIMEZONE,
      },
      {
        name: WEEKLY_ROLLOUT_JOB,
        opts: {
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 50 },
        },
      },
    );
    this.logger.log(
      `weekly-rollout scheduler upserted (pattern=${WEEKLY_ROLLOUT_CRON_EXPRESSION} tz=${WEEKLY_ROLLOUT_CRON_TIMEZONE})`,
    );
  }
}
