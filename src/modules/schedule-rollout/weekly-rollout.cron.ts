import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Inject } from '@nestjs/common';
import { WeeklyRolloutService } from './weekly-rollout.service';

/**
 * Cron expression: `0 23 * * 0` = "Sunday 23:00", in Asia/Almaty.
 *
 * That cadence matches BP §9.3 — the cron fires Sunday 23:00 Almaty (UTC+5,
 * no DST since 2005), which is 18:00 UTC Sunday. At that point the *current*
 * week (Mon–Sun in Almaty) has just finished, so we use it as the source
 * week and project everything onto Mon–Sun of the *next* week.
 */
export const WEEKLY_ROLLOUT_CRON_NAME = 'weekly-rollout';
export const WEEKLY_ROLLOUT_CRON_EXPRESSION = '0 23 * * 0';
export const WEEKLY_ROLLOUT_CRON_TIMEZONE = 'Asia/Almaty';

/**
 * WeeklyRolloutCron — `@nestjs/schedule` driver for the weekly auto-copy
 * (T5 in B7). The actual orchestration (per-kg `SET LOCAL
 * app.kindergarten_id` + `tenantStorage.run`) lives in
 * `WeeklyRolloutService.runWeeklyRollout`; this class owns only the cron
 * decorator and the previous-Monday computation.
 *
 * TODO(B9): move cron to dedicated worker process when BullMQ split lands.
 *   Once the api / worker / ws process split happens in B9, this driver
 *   should run only in the worker process. Until then it is registered in
 *   the single-process app and is therefore best-effort: a horizontally
 *   scaled API will fire the cron from each instance.
 *
 *   See `IMPLEMENTATION_PLAN.md` §5 Active for the cron-lock follow-up
 *   tracker.
 */
// TODO(B9): add cron lock via Redis SET NX EX once the API horizontally
// scales — current single-process deployment makes this unnecessary.
@Injectable()
export class WeeklyRolloutCron {
  private readonly logger = new Logger(WeeklyRolloutCron.name);

  constructor(
    private readonly rollout: WeeklyRolloutService,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  @Cron(WEEKLY_ROLLOUT_CRON_EXPRESSION, {
    timeZone: WEEKLY_ROLLOUT_CRON_TIMEZONE,
    name: WEEKLY_ROLLOUT_CRON_NAME,
  })
  async handleWeeklyRollout(): Promise<void> {
    const now = this.clock.now();
    const fromMonday = this.rollout.computePreviousMonday(now);
    this.logger.log(
      `weekly-rollout cron tick: now=${now.toISOString()} fromMonday=${fromMonday.toISOString().slice(0, 10)}`,
    );
    try {
      const summary = await this.rollout.runWeeklyRollout({
        fromMonday,
        source: 'cron',
      });
      this.logger.log(
        `weekly-rollout cron summary: kgs=${summary.totals.kindergartens} copiedGroups=${summary.totals.copiedGroups} skippedGroups=${summary.totals.skippedGroups} totalEvents=${summary.totals.totalEvents} plansCreated=${summary.totals.plansCreated} plansSkipped=${summary.totals.plansSkipped} errors=${summary.totals.errors}`,
      );
    } catch (err) {
      // The service catches per-kg errors itself, so reaching this branch
      // means the bypass-rls directory scan or something equally global
      // failed. Surface it loudly but do not crash the process.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`weekly-rollout cron failed: ${msg}`);
    }
  }
}
