import { Module } from '@nestjs/common';
import { KindergartenModule } from '@/modules/kindergarten/kindergarten.module';
import { MealModule } from '@/modules/meal/meal.module';
import { ScheduleModule } from '@/modules/schedule/schedule.module';
import { ScheduleRolloutAdminController } from './schedule-rollout.admin.controller';
import { WeeklyRolloutService } from './weekly-rollout.service';

/**
 * ScheduleRolloutModule — narrow module that hosts the weekly auto-copy
 * service and its manual-trigger admin endpoint (T5 in B7).
 *
 * - ScheduleModule exports `ScheduleService` for `copyWeekToNext`.
 * - MealModule exports `MealService` for `copyWeekMenuToNext`.
 * - KindergartenModule exports `KindergartenRepository` for the active-kg
 *   directory scan.
 *
 * B9 T6 split: the recurring cron driver moved out of this module into
 * `WeeklyRolloutProcessor` (BullMQ) under `WorkerModule`. The api process
 * still loads this module so the admin manual-trigger endpoint can call
 * `WeeklyRolloutService.runWeeklyRollout` directly. The previous
 * `WeeklyRolloutCron` provider is gone — `@nestjs/schedule` is no longer
 * required by this module (the package stays in deps for any future cron
 * use).
 */
@Module({
  imports: [ScheduleModule, MealModule, KindergartenModule],
  controllers: [ScheduleRolloutAdminController],
  providers: [WeeklyRolloutService],
  exports: [WeeklyRolloutService],
})
export class ScheduleRolloutModule {}
