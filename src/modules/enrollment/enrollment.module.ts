import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BillingModule } from '@/modules/billing/billing.module';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { EnrollmentStatusLogRepository } from './infrastructure/persistence/enrollment-status-log.repository';
import { EnrollmentRepository } from './infrastructure/persistence/enrollment.repository';
import { EnrollmentStatusLogEntity } from './infrastructure/persistence/relational/entities/enrollment-status-log.entity';
import { EnrollmentEntity } from './infrastructure/persistence/relational/entities/enrollment.entity';
import { EnrollmentStatusLogRelationalRepository } from './infrastructure/persistence/relational/repositories/enrollment-status-log-relational.repository';
import { EnrollmentRelationalRepository } from './infrastructure/persistence/relational/repositories/enrollment-relational.repository';
import { EnrollmentController } from './enrollment.controller';
import { EnrollmentService } from './enrollment.service';

/**
 * EnrollmentModule — wires the enrollment lead aggregate (B5). Imports
 * ChildModule (exports ChildService for card_created side-effect),
 * GroupModule (exports GroupRepository for group validation on card_created),
 * StaffModule (exports StaffMemberRepository for assignedTo validation and
 * caller resolution), and BillingModule (exports InvoiceService for the B13
 * card_created → first-month invoice cross-module hook).
 *
 * ClockPort is provided globally by SharedKernelModule (@Global) so it is
 * not imported here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([EnrollmentEntity, EnrollmentStatusLogEntity]),
    ChildModule,
    GroupModule,
    StaffModule,
    BillingModule,
  ],
  controllers: [EnrollmentController],
  providers: [
    EnrollmentService,
    {
      provide: EnrollmentRepository,
      useClass: EnrollmentRelationalRepository,
    },
    {
      provide: EnrollmentStatusLogRepository,
      useClass: EnrollmentStatusLogRelationalRepository,
    },
  ],
})
export class EnrollmentModule {}
