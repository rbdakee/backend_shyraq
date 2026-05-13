import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { AdminAttendanceController } from './admin-attendance.controller';
import { AttendanceService } from './attendance.service';
import { ParentAttendanceController } from './parent-attendance.controller';
import { StaffAttendanceController } from './staff-attendance.controller';
import { StaffDailyStatusController } from './staff-daily-status.controller';
import { StaffTimelineController } from './staff-timeline.controller';
import { TimelineService } from './timeline.service';
import { AttendanceEventRepository } from './infrastructure/persistence/attendance-event.repository';
import { ChildDailyStatusRepository } from './infrastructure/persistence/child-daily-status.repository';
import { TimelineEntryRepository } from './infrastructure/persistence/timeline-entry.repository';
import { AttendanceEventTypeOrmEntity } from './infrastructure/persistence/relational/entities/attendance-event.typeorm.entity';
import { ChildDailyStatusTypeOrmEntity } from './infrastructure/persistence/relational/entities/child-daily-status.typeorm.entity';
import { TimelineEntryTypeOrmEntity } from './infrastructure/persistence/relational/entities/timeline-entry.typeorm.entity';
import { AttendanceEventRelationalRepository } from './infrastructure/persistence/relational/repositories/attendance-event.relational.repository';
import { ChildDailyStatusRelationalRepository } from './infrastructure/persistence/relational/repositories/child-daily-status.relational.repository';
import { TimelineEntryRelationalRepository } from './infrastructure/persistence/relational/repositories/timeline-entry.relational.repository';

/**
 * AttendanceModule (B8). Wires the attendance_events / child_daily_status /
 * timeline_entries aggregate.
 *
 *   - ChildModule exports ChildRepository + ChildGuardianRepository (used for
 *     child existence + pickup-permission validation).
 *   - StaffModule exports StaffMemberRepository (caller resolution).
 *   - SharedKernelModule (global) provides ClockPort + NotificationPort.
 *
 * AttendanceService and TimelineService are exported so they can be consumed
 * by other modules if needed (e.g. future notification module).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttendanceEventTypeOrmEntity,
      ChildDailyStatusTypeOrmEntity,
      TimelineEntryTypeOrmEntity,
    ]),
    ChildModule,
    GroupModule,
    StaffModule,
  ],
  controllers: [
    StaffAttendanceController,
    StaffTimelineController,
    StaffDailyStatusController,
    AdminAttendanceController,
    ParentAttendanceController,
  ],
  providers: [
    AttendanceService,
    TimelineService,
    {
      provide: AttendanceEventRepository,
      useClass: AttendanceEventRelationalRepository,
    },
    {
      provide: ChildDailyStatusRepository,
      useClass: ChildDailyStatusRelationalRepository,
    },
    {
      provide: TimelineEntryRepository,
      useClass: TimelineEntryRelationalRepository,
    },
  ],
  exports: [
    AttendanceService,
    TimelineService,
    AttendanceEventRepository,
    ChildDailyStatusRepository,
    TimelineEntryRepository,
  ],
})
export class AttendanceModule {}
