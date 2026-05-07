import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { StaffModule } from '@/modules/staff/staff.module';
import { AdminDiagnosticTemplateController } from './admin-diagnostic-template.controller';
import { DiagnosticEntryService } from './diagnostic-entry.service';
import { DiagnosticEntryRepository } from './diagnostic-entry.repository';
import { DiagnosticTemplateService } from './diagnostic-template.service';
import { DiagnosticTemplateRepository } from './diagnostic-template.repository';
import { MyTodosService } from './my-todos.service';
import { ParentDiagnosticController } from './parent-diagnostic.controller';
import { ProgressNoteService } from './progress-note.service';
import { ProgressNoteRepository } from './progress-note.repository';
import { StaffDiagnosticEntryController } from './staff-diagnostic-entry.controller';
import { StaffDiagnosticTemplateController } from './staff-diagnostic-template.controller';
import { StaffMyTodosController } from './staff-my-todos.controller';
import { StaffProgressNoteController } from './staff-progress-note.controller';
import { DiagnosticEntryRelationalEntity } from './infrastructure/persistence/relational/entities/diagnostic-entry.entity';
import { DiagnosticTemplateRelationalEntity } from './infrastructure/persistence/relational/entities/diagnostic-template.entity';
import { ProgressNoteRelationalEntity } from './infrastructure/persistence/relational/entities/progress-note.entity';
import { DiagnosticEntryRelationalRepository } from './infrastructure/persistence/relational/repositories/diagnostic-entry.relational-repository';
import { DiagnosticTemplateRelationalRepository } from './infrastructure/persistence/relational/repositories/diagnostic-template.relational-repository';
import { ProgressNoteRelationalRepository } from './infrastructure/persistence/relational/repositories/progress-note.relational-repository';

/**
 * DiagnosticsModule (B18) — wires the four services + 3 abstract repository
 * ports → relational adapters. Imports `ChildModule` for `ChildRepository`
 * (used by `MyTodosService.listActiveLightByKg`) and `ChildGuardianRepository`
 * (used by `ParentDiagnosticController`). Imports `StaffModule` for
 * `StaffMemberRepository` (used by all staff controllers to resolve
 * caller → staff_member_id).
 *
 * `ClockPort` resolves via the @Global `SharedKernelModule`.
 * `NotificationPort` is supplied at the application root.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiagnosticTemplateRelationalEntity,
      DiagnosticEntryRelationalEntity,
      ProgressNoteRelationalEntity,
    ]),
    ChildModule,
    StaffModule,
  ],
  controllers: [
    AdminDiagnosticTemplateController,
    StaffDiagnosticTemplateController,
    StaffDiagnosticEntryController,
    StaffProgressNoteController,
    StaffMyTodosController,
    ParentDiagnosticController,
  ],
  providers: [
    {
      provide: DiagnosticTemplateRepository,
      useClass: DiagnosticTemplateRelationalRepository,
    },
    {
      provide: DiagnosticEntryRepository,
      useClass: DiagnosticEntryRelationalRepository,
    },
    {
      provide: ProgressNoteRepository,
      useClass: ProgressNoteRelationalRepository,
    },
    DiagnosticTemplateService,
    DiagnosticEntryService,
    ProgressNoteService,
    MyTodosService,
  ],
  exports: [
    DiagnosticTemplateRepository,
    DiagnosticEntryRepository,
    ProgressNoteRepository,
    DiagnosticTemplateService,
    DiagnosticEntryService,
    ProgressNoteService,
    MyTodosService,
  ],
})
export class DiagnosticsModule {}
