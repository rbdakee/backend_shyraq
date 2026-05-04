import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocationModule } from '@/modules/location/location.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { GroupController } from './group.controller';
import { GroupRepository } from './infrastructure/persistence/group.repository';
import { GroupService } from './group.service';
import { GroupEntity } from './infrastructure/persistence/relational/entities/group.entity';
import { GroupMentorEntity } from './infrastructure/persistence/relational/entities/group-mentor.entity';
import { GroupRelationalRepository } from './infrastructure/persistence/relational/repositories/group.repository';

/**
 * GroupModule — wires the rich group + group_mentors aggregate. Imports
 * StaffModule (to look up StaffMemberRepository for assignMentor pre-checks)
 * and LocationModule (to validate `current_location_id` on create/update).
 *
 * `StaffModule` is imported with `forwardRef` because StaffService imports
 * `GroupRepository` (for the F10 mentor cascade on deactivate/archive),
 * which closes the dependency cycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([GroupEntity, GroupMentorEntity]),
    forwardRef(() => StaffModule),
    LocationModule,
  ],
  controllers: [GroupController],
  providers: [
    GroupService,
    {
      provide: GroupRepository,
      useClass: GroupRelationalRepository,
    },
  ],
  exports: [GroupRepository, GroupService],
})
export class GroupModule {}
