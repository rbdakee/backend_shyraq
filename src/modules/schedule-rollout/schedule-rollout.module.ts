import { Module } from '@nestjs/common';
import { KindergartenModule } from '@/modules/kindergarten/kindergarten.module';
import { MealModule } from '@/modules/meal/meal.module';
import { ScheduleModule } from '@/modules/schedule/schedule.module';
import { ScheduleRolloutAdminController } from './schedule-rollout.admin.controller';
import { WeeklyRolloutCron } from './weekly-rollout.cron';
import { WeeklyRolloutService } from './weekly-rollout.service';

/**
 * ScheduleRolloutModule — narrow module that hosts the weekly auto-copy
 * cron and its manual-trigger admin endpoint (T5 in B7).
 *
 * - ScheduleModule exports `ScheduleService` for `copyWeekToNext`.
 * - MealModule exports `MealService` for `copyWeekMenuToNext`.
 * - KindergartenModule exports `KindergartenRepository` for the active-kg
 *   directory scan.
 *
 * The cron registration via `WeeklyRolloutCron` requires
 * `ScheduleModule.forRoot()` (the @nestjs/schedule one) to be wired in
 * `AppModule`. This module only depends on @Cron decorators being picked
 * up by the runtime scheduler — see `app.module.ts`.
 */
@Module({
  imports: [ScheduleModule, MealModule, KindergartenModule],
  controllers: [ScheduleRolloutAdminController],
  providers: [WeeklyRolloutService, WeeklyRolloutCron],
  exports: [WeeklyRolloutService],
})
export class ScheduleRolloutModule {}
