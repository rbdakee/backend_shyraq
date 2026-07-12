import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '@/modules/users/users.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { SpecialistTypeModule } from '@/modules/specialist-type/specialist-type.module';
import { StorageModule } from '@/shared-kernel/storage/storage.module';
import { KindergartenEntity } from './infrastructure/persistence/relational/entities/kindergarten.entity';
import { KindergartenRelationalRepository } from './infrastructure/persistence/relational/repositories/kindergarten.repository';
import { AdminKindergartenLogoController } from './admin-kindergarten-logo.controller';
import { KindergartenController } from './kindergarten.controller';
import { KindergartenRepository } from './infrastructure/persistence/kindergarten.repository';
import { KindergartenService } from './kindergarten.service';
import { SuperAdminKindergartenController } from './super-admin-kindergarten.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([KindergartenEntity]),
    UsersModule,
    forwardRef(() => StaffModule),
    StorageModule,
    SpecialistTypeModule,
  ],
  controllers: [
    KindergartenController,
    AdminKindergartenLogoController,
    SuperAdminKindergartenController,
  ],
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
