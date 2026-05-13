import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { GroupModule } from '@/modules/group/group.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { UsersModule } from '@/modules/users/users.module';
import { ChildGuardianRepository } from './infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from './infrastructure/persistence/child.repository';
import { ChildStatusHistoryRepository } from './infrastructure/persistence/child-status-history.repository';
import { AdminLifecycleController } from './admin-lifecycle.controller';
import { AdminLifecycleService } from './admin-lifecycle.service';
import { ChildController } from './child.controller';
import { ChildService } from './child.service';
import { ChildEntity } from './infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from './infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from './infrastructure/persistence/relational/entities/child-guardian.entity';
import { ChildStatusHistoryEntity } from './infrastructure/persistence/relational/entities/child-status-history.entity';
import { ChildGuardianRelationalRepository } from './infrastructure/persistence/relational/repositories/child-guardian.repository';
import { ChildRelationalRepository } from './infrastructure/persistence/relational/repositories/child.repository';
import { ChildStatusHistoryRelationalRepository } from './infrastructure/persistence/relational/repositories/child-status-history.repository';
import {
  BillingLifecyclePort,
  NoopBillingLifecycleAdapter,
} from './infrastructure/billing-lifecycle.port';
import { LIFECYCLE_QUEUE } from './lifecycle-queue.constants';
import { ParentApprovalController } from './parent-approval.controller';
import { ParentChildController } from './parent-child.controller';
import { ParentLinkController } from './parent-link.controller';

/**
 * ChildModule — wires the child + child_guardian + child_group_history
 * aggregate. Imports GroupModule (for currentLocation/groupId validation),
 * StaffModule (audit on transfer), and UsersModule (find-or-create user by
 * phone during inviteGuardian).
 *
 * Notification fan-out lives in `SharedKernelModule.NotificationPort` (global)
 * so this module does not have to wire its own provider.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ChildEntity,
      ChildGuardianEntity,
      ChildGroupHistoryEntity,
      ChildStatusHistoryEntity,
    ]),
    // B21 T3: enqueue `lifecycle:pro-rata-refund` jobs from
    // `ChildService.archive`. Worker process (`WorkerModule`) registers the
    // processor on the same queue name; the API process is publisher-only.
    BullModule.registerQueue({ name: LIFECYCLE_QUEUE }),
    GroupModule,
    StaffModule,
    UsersModule,
  ],
  controllers: [
    ChildController,
    ParentChildController,
    ParentApprovalController,
    ParentLinkController,
    AdminLifecycleController,
  ],
  providers: [
    ChildService,
    AdminLifecycleService,
    ChildAccessGuard,
    { provide: ChildRepository, useClass: ChildRelationalRepository },
    {
      provide: ChildGuardianRepository,
      useClass: ChildGuardianRelationalRepository,
    },
    {
      provide: ChildStatusHistoryRepository,
      useClass: ChildStatusHistoryRelationalRepository,
    },
    // Default no-op for the billing-lifecycle bridge so service-unit
    // wiring outside the full app graph compiles. The production binding
    // lives in `BillingLifecycleBridgeModule` (`@Global()`), which
    // overrides this token for every consumer that imports it.
    {
      provide: BillingLifecyclePort,
      useClass: NoopBillingLifecycleAdapter,
    },
  ],
  exports: [
    ChildRepository,
    ChildGuardianRepository,
    ChildStatusHistoryRepository,
    ChildService,
    BillingLifecyclePort,
    // Re-export the queue token via the BullMQ module so consumers that
    // import ChildModule can `@InjectQueue(LIFECYCLE_QUEUE)`.
    BullModule,
  ],
})
export class ChildModule {}
