import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { WeeklyRolloutService } from './weekly-rollout.service';

/**
 * BullMQ queue + repeatable job names for the weekly schedule rollout. The
 * worker (T6) registers a repeatable job under this queue at boot; the api
 * process never enqueues onto it. Manual triggers go through the admin
 * endpoint, which calls `WeeklyRolloutService.runWeeklyRollout` directly
 * without touching BullMQ.
 *
 * Cron expression / timezone match the previous `@nestjs/schedule` decoration
 * exactly so the operational contract (BP §9.3) is unchanged.
 */
export const WEEKLY_ROLLOUT_QUEUE = 'schedule-rollout';
export const WEEKLY_ROLLOUT_JOB = 'weekly-rollout';
export const WEEKLY_ROLLOUT_CRON_EXPRESSION = '0 23 * * 0';
export const WEEKLY_ROLLOUT_CRON_TIMEZONE = 'Asia/Almaty';

/**
 * WeeklyRolloutProcessor — BullMQ replacement for the previous
 * `@nestjs/schedule` `@Cron` driver. Distributed lock comes free via the
 * BullMQ queue: only one worker claims the scheduled job per tick, even
 * when several worker processes run in parallel.
 *
 * The processor stays thin: derive `previousMonday` from the injected
 * clock (so timezone math lives in one place), delegate to
 * `WeeklyRolloutService.runWeeklyRollout`, and surface a top-level
 * exception via the logger so a single tick failure does not crash the
 * worker. The service catches per-kg errors itself.
 */
@Processor(WEEKLY_ROLLOUT_QUEUE)
export class WeeklyRolloutProcessor extends WorkerHost {
  private readonly logger = new Logger(WeeklyRolloutProcessor.name);

  constructor(
    private readonly rollout: WeeklyRolloutService,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== WEEKLY_ROLLOUT_JOB) {
      // Future jobs on the same queue may exist; the processor only owns
      // the scheduled rollout job and silently ignores the rest.
      return;
    }
    const now = this.clock.now();
    const fromMonday = this.rollout.computePreviousMonday(now);
    this.logger.log(
      `weekly-rollout job tick: now=${now.toISOString()} fromMonday=${fromMonday.toISOString().slice(0, 10)}`,
    );
    try {
      const summary = await this.rollout.runWeeklyRollout({
        fromMonday,
        source: 'cron',
      });
      this.logger.log(
        `weekly-rollout job summary: kgs=${summary.totals.kindergartens} copiedGroups=${summary.totals.copiedGroups} skippedGroups=${summary.totals.skippedGroups} totalEvents=${summary.totals.totalEvents} plansCreated=${summary.totals.plansCreated} plansSkipped=${summary.totals.plansSkipped} errors=${summary.totals.errors}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`weekly-rollout job failed: ${msg}`);
    }
  }
}
