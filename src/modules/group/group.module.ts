import { Module } from '@nestjs/common';
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
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([GroupEntity, GroupMentorEntity]),
    StaffModule,
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
