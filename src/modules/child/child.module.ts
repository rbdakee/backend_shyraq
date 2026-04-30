import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { GroupModule } from '@/modules/group/group.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { UsersModule } from '@/modules/users/users.module';
import { ChildGuardianRepository } from './infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from './infrastructure/persistence/child.repository';
import { ChildController } from './child.controller';
import { ChildService } from './child.service';
import { ChildEntity } from './infrastructure/persistence/relational/entities/child.entity';
import { ChildGroupHistoryEntity } from './infrastructure/persistence/relational/entities/child-group-history.entity';
import { ChildGuardianEntity } from './infrastructure/persistence/relational/entities/child-guardian.entity';
import { ChildGuardianRelationalRepository } from './infrastructure/persistence/relational/repositories/child-guardian.repository';
import { ChildRelationalRepository } from './infrastructure/persistence/relational/repositories/child.repository';
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
    ]),
    GroupModule,
    StaffModule,
    UsersModule,
  ],
  controllers: [
    ChildController,
    ParentChildController,
    ParentApprovalController,
    ParentLinkController,
  ],
  providers: [
    ChildService,
    ChildAccessGuard,
    { provide: ChildRepository, useClass: ChildRelationalRepository },
    {
      provide: ChildGuardianRepository,
      useClass: ChildGuardianRelationalRepository,
    },
  ],
  exports: [ChildRepository, ChildGuardianRepository, ChildService],
})
export class ChildModule {}
