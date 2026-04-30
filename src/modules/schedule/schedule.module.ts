import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { ActivityEventRepository } from './infrastructure/persistence/activity-event.repository';
import { ScheduleTemplateRepository } from './infrastructure/persistence/schedule-template.repository';
import { ScheduleWeekSnapshotRepository } from './infrastructure/persistence/schedule-week-snapshot.repository';
import { ActivityEventEntity } from './infrastructure/persistence/relational/entities/activity-event.entity';
import { ScheduleTemplateEntity } from './infrastructure/persistence/relational/entities/schedule-template.entity';
import { ScheduleTemplateSlotEntity } from './infrastructure/persistence/relational/entities/schedule-template-slot.entity';
import { ScheduleWeekSnapshotEntity } from './infrastructure/persistence/relational/entities/schedule-week-snapshot.entity';
import { ActivityEventRelationalRepository } from './infrastructure/persistence/relational/repositories/activity-event-relational.repository';
import { ScheduleTemplateRelationalRepository } from './infrastructure/persistence/relational/repositories/schedule-template-relational.repository';
import { ScheduleWeekSnapshotRelationalRepository } from './infrastructure/persistence/relational/repositories/schedule-week-snapshot-relational.repository';
import { ScheduleAdminController } from './schedule.admin.controller';
import { ScheduleParentController } from './schedule.parent.controller';
import { ScheduleService } from './schedule.service';
import { ScheduleStaffController } from './schedule.staff.controller';

/**
 * ScheduleModule (B7). Wires the schedule_templates / schedule_template_slots
 * / activity_events / schedule_week_snapshots aggregate.
 *
 *   - GroupModule exports `GroupRepository` for tenant-scoped group lookups.
 *   - ChildModule exports `ChildRepository` so the parent endpoint can
 *     resolve the child's `current_group_id`.
 *
 * Exports `ScheduleService` for B8/B17 cron task wiring (T5: schedule
 * `auto-copy` cron will reuse `copyWeekToNext`).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ScheduleTemplateEntity,
      ScheduleTemplateSlotEntity,
      ActivityEventEntity,
      ScheduleWeekSnapshotEntity,
    ]),
    GroupModule,
    ChildModule,
  ],
  controllers: [
    ScheduleAdminController,
    ScheduleStaffController,
    ScheduleParentController,
  ],
  providers: [
    ScheduleService,
    {
      provide: ScheduleTemplateRepository,
      useClass: ScheduleTemplateRelationalRepository,
    },
    {
      provide: ActivityEventRepository,
      useClass: ActivityEventRelationalRepository,
    },
    {
      provide: ScheduleWeekSnapshotRepository,
      useClass: ScheduleWeekSnapshotRelationalRepository,
    },
  ],
  exports: [ScheduleService],
})
export class ScheduleModule {}
