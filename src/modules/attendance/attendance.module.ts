import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { AttendanceService } from './attendance.service';
import { AttendanceEventRepository } from './infrastructure/persistence/attendance-event.repository';
import { ChildDailyStatusRepository } from './infrastructure/persistence/child-daily-status.repository';
import { TimelineEntryRepository } from './infrastructure/persistence/timeline-entry.repository';
import { AttendanceEventTypeOrmEntity } from './infrastructure/persistence/relational/entities/attendance-event.typeorm.entity';
import { ChildDailyStatusTypeOrmEntity } from './infrastructure/persistence/relational/entities/child-daily-status.typeorm.entity';
import { TimelineEntryTypeOrmEntity } from './infrastructure/persistence/relational/entities/timeline-entry.typeorm.entity';
import { AttendanceEventRelationalRepository } from './infrastructure/persistence/relational/repositories/attendance-event.relational.repository';
import { ChildDailyStatusRelationalRepository } from './infrastructure/persistence/relational/repositories/child-daily-status.relational.repository';
import { TimelineEntryRelationalRepository } from './infrastructure/persistence/relational/repositories/timeline-entry.relational.repository';
import { StaffAttendanceController } from './staff-attendance.controller';

/**
 * AttendanceModule (B8). Wires the attendance_events / child_daily_status /
 * timeline_entries aggregate.
 *
 *   - ChildModule exports ChildRepository + ChildGuardianRepository (used for
 *     child existence + pickup-permission validation).
 *   - StaffModule exports StaffMemberRepository (caller resolution).
 *   - SharedKernelModule (global) provides ClockPort + NotificationPort.
 *
 * AttendanceService is exported so T4's standalone admin/parent attendance
 * controllers and timeline service can compose it.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      AttendanceEventTypeOrmEntity,
      ChildDailyStatusTypeOrmEntity,
      TimelineEntryTypeOrmEntity,
    ]),
    ChildModule,
    StaffModule,
  ],
  controllers: [StaffAttendanceController],
  providers: [
    AttendanceService,
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
    AttendanceEventRepository,
    ChildDailyStatusRepository,
    TimelineEntryRepository,
  ],
})
export class AttendanceModule {}
