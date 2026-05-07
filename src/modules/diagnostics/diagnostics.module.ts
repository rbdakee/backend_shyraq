import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { DiagnosticEntryService } from './diagnostic-entry.service';
import { DiagnosticEntryRepository } from './diagnostic-entry.repository';
import { DiagnosticTemplateService } from './diagnostic-template.service';
import { DiagnosticTemplateRepository } from './diagnostic-template.repository';
import { MyTodosService } from './my-todos.service';
import { ProgressNoteService } from './progress-note.service';
import { ProgressNoteRepository } from './progress-note.repository';
import { DiagnosticEntryRelationalEntity } from './infrastructure/persistence/relational/entities/diagnostic-entry.entity';
import { DiagnosticTemplateRelationalEntity } from './infrastructure/persistence/relational/entities/diagnostic-template.entity';
import { ProgressNoteRelationalEntity } from './infrastructure/persistence/relational/entities/progress-note.entity';
import { DiagnosticEntryRelationalRepository } from './infrastructure/persistence/relational/repositories/diagnostic-entry.relational-repository';
import { DiagnosticTemplateRelationalRepository } from './infrastructure/persistence/relational/repositories/diagnostic-template.relational-repository';
import { ProgressNoteRelationalRepository } from './infrastructure/persistence/relational/repositories/progress-note.relational-repository';

/**
 * DiagnosticsModule (B18) — wires the four services + 3 abstract repository
 * ports → relational adapters. Imports `ChildModule` for `ChildRepository`
 * (used by `MyTodosService.listActiveLightByKg`). `ClockPort` resolves via
 * the @Global SharedKernelModule. T4 expands the surface with controllers
 * + DTOs and registers `DiagnosticsModule` in `app.module.ts`.
 *
 * `NotificationPort` is supplied at the application root (app.module wires
 * it to either `OutboxNotificationAdapter` for production or
 * `InMemoryNotificationAdapter` for tests). We do NOT bind it here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      DiagnosticTemplateRelationalEntity,
      DiagnosticEntryRelationalEntity,
      ProgressNoteRelationalEntity,
    ]),
    ChildModule,
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
