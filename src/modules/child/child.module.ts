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
    // NOTE: do NOT register a local `BillingLifecyclePort` provider here.
    // A module-local provider takes precedence over an imported one — even
    // a `@Global()` one — for components declared in the same module. A
    // local Noop here would shadow the real `BillingLifecycleAdapter` from
    // the `@Global() BillingLifecycleBridgeModule` *for `ChildService`
    // itself*, making `activateChild` always 409 `child_activation_requires_tariff`
    // and `archive` silently skip closing tariff assignments. The real
    // adapter is supplied globally by `BillingLifecycleBridgeModule`.
    // `NoopBillingLifecycleAdapter` still exists for service-unit fakes,
    // which construct `ChildService` directly rather than via DI.
  ],
  exports: [
    ChildRepository,
    ChildGuardianRepository,
    // ChildStatusHistoryRepository intentionally NOT exported (T13 M7
    // opus): it's only consumed by ChildService inside this module, so
    // exporting it would leak module-internal persistence detail per
    // CLAUDE.md §4 module-boundary discipline.
    ChildService,
    // BillingLifecyclePort is NOT exported: it has no local provider here
    // anymore (see the providers note above), so re-exporting it would throw
    // UnknownExportException at boot. Consumers needing the port get the real
    // adapter from the `@Global() BillingLifecycleBridgeModule` directly.
    // Re-export the queue token via the BullMQ module so consumers that
    // import ChildModule can `@InjectQueue(LIFECYCLE_QUEUE)`.
    BullModule,
  ],
})
export class ChildModule {}
