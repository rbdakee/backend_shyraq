import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StaffMemberEntity } from './infrastructure/persistence/relational/entities/staff-member.entity';
import { StaffMemberRelationalRepository } from './infrastructure/persistence/relational/repositories/staff-member.repository';
import { StaffMemberRepository } from './staff-member.repository';

/**
 * Minimal staff module — exposes StaffMemberRepository so that other modules
 * (KindergartenModule for admin seeding, AuthModule for role assembly in P4)
 * can resolve it via DI. Controllers + service for staff CRUD land in P4.
 */
@Module({
  imports: [TypeOrmModule.forFeature([StaffMemberEntity])],
  providers: [
    {
      provide: StaffMemberRepository,
      useClass: StaffMemberRelationalRepository,
    },
  ],
  exports: [StaffMemberRepository],
})
export class StaffModule {}
