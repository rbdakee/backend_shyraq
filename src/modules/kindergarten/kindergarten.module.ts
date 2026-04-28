import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '@/modules/users/users.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { KindergartenEntity } from './infrastructure/persistence/relational/entities/kindergarten.entity';
import { KindergartenRelationalRepository } from './infrastructure/persistence/relational/repositories/kindergarten.repository';
import { KindergartenController } from './kindergarten.controller';
import { KindergartenRepository } from './kindergarten.repository';
import { KindergartenService } from './kindergarten.service';
import { SuperAdminKindergartenController } from './super-admin-kindergarten.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([KindergartenEntity]),
    UsersModule,
    forwardRef(() => StaffModule),
  ],
  controllers: [KindergartenController, SuperAdminKindergartenController],
  providers: [
    KindergartenService,
    {
      provide: KindergartenRepository,
      useClass: KindergartenRelationalRepository,
    },
  ],
  exports: [KindergartenRepository, KindergartenService],
})
export class KindergartenModule {}
