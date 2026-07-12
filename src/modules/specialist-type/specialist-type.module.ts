import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminSpecialistTypeController } from './admin-specialist-type.controller';
import { SpecialistTypeEntity } from './infrastructure/persistence/relational/entities/specialist-type.entity';
import { SpecialistTypeRepository } from './infrastructure/persistence/specialist-type.repository';
import { SpecialistTypeRelationalRepository } from './infrastructure/persistence/relational/repositories/specialist-type.relational.repository';
import { SpecialistTypeService } from './specialist-type.service';

/**
 * Admin-managed per-kindergarten specialist-type directory (N12). Exports both
 * the service (for the kg-create seed-hook) and the repository/service so
 * StaffModule + DiagnosticsModule can validate `specialist_type` codes against
 * the active directory. ClockPort is provided globally by SharedKernelModule.
 */
@Module({
  imports: [TypeOrmModule.forFeature([SpecialistTypeEntity])],
  controllers: [AdminSpecialistTypeController],
  providers: [
    SpecialistTypeService,
    {
      provide: SpecialistTypeRepository,
      useClass: SpecialistTypeRelationalRepository,
    },
  ],
  exports: [SpecialistTypeRepository, SpecialistTypeService],
})
export class SpecialistTypeModule {}
