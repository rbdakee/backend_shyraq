import { Module } from '@nestjs/common';
import { AttendanceModule } from '@/modules/attendance/attendance.module';
import { BillingModule } from '@/modules/billing/billing.module';
import { ChildModule } from '@/modules/child/child.module';
import { EnrollmentModule } from '@/modules/enrollment/enrollment.module';
import { GroupModule } from '@/modules/group/group.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * DashboardModule (B-DASH) — read-only analytics aggregator. Owns no table.
 *
 * It only composes already-existing bounded-context ports, so it imports the
 * owning feature modules for their exported repositories:
 *  - ChildModule        → ChildRepository
 *  - EnrollmentModule   → EnrollmentRepository (export added in this batch)
 *  - BillingModule      → InvoiceRepository, PaymentRepository, RefundRepository
 *  - StaffModule        → StaffMemberRepository
 *  - GroupModule        → GroupRepository
 *  - AttendanceModule   → AttendanceEventRepository, ChildDailyStatusRepository
 *
 * ClockPort is provided globally by SharedKernelModule (@Global). No port
 * {provide,useClass} is declared here — the relational impls come from the
 * imported modules; this module never touches TypeORM directly.
 */
@Module({
  imports: [
    ChildModule,
    EnrollmentModule,
    BillingModule,
    StaffModule,
    GroupModule,
    AttendanceModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
