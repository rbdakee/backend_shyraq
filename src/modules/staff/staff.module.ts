import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { KindergartenModule } from '@/modules/kindergarten/kindergarten.module';
import { UsersModule } from '@/modules/users/users.module';
import { StaffMemberEntity } from './infrastructure/persistence/relational/entities/staff-member.entity';
import { StaffMemberRelationalRepository } from './infrastructure/persistence/relational/repositories/staff-member.repository';
import { StaffController } from './staff.controller';
import { StaffMemberRepository } from './infrastructure/persistence/staff-member.repository';
import { StaffService } from './staff.service';

/**
 * StaffModule — exposes the StaffMemberRepository (so KindergartenModule can
 * seed admins and AuthModule can assemble role lists) plus the P4 admin
 * CRUD surface (StaffController + StaffService).
 *
 * KindergartenModule is wired with `forwardRef` because both modules
 * legitimately depend on each other: StaffService needs to look up the
 * kindergarten name for the welcome SMS, and KindergartenService needs
 * StaffMemberRepository to seed admins.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([StaffMemberEntity]),
    UsersModule,
    forwardRef(() => KindergartenModule),
  ],
  controllers: [StaffController],
  providers: [
    StaffService,
    {
      provide: StaffMemberRepository,
      useClass: StaffMemberRelationalRepository,
    },
  ],
  exports: [StaffMemberRepository, StaffService],
})
export class StaffModule {}
