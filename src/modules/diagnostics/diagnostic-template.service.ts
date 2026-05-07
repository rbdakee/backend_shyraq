import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  DiagnosticTemplateListResult,
  DiagnosticTemplateRepository,
  ListDiagnosticTemplatesFilter,
} from './diagnostic-template.repository';
import {
  DiagnosticTemplate,
  DiagnosticTemplateState,
  DiagnosticTemplateUpdatePatch,
} from './domain/entities/diagnostic-template.entity';
import { DiagnosticTemplateNotFoundError } from './domain/errors/diagnostic-template-not-found.error';
import { TemplateSchema } from './domain/schema-validators';

export interface CreateDiagnosticTemplateInput {
  specialistType: string;
  name: string;
  description?: string | null;
  schema: TemplateSchema;
}

@Injectable()
export class DiagnosticTemplateService {
  constructor(
    private readonly templates: DiagnosticTemplateRepository,
    private readonly clock: ClockPort,
  ) {}

  /**
   * INSERT a new diagnostic template. The constructor (`fromState`) runs
   * `validateTemplateSchemaShape` against the provided schema and rejects
   * malformed shapes with `DiagnosticTemplateSchemaInvalidError` (400).
   */
  async create(
    kgId: string,
    input: CreateDiagnosticTemplateInput,
    createdByStaffMemberId: string,
  ): Promise<DiagnosticTemplate> {
    const now = this.clock.now();
    const state: DiagnosticTemplateState = {
      id: randomUUID(),
      kindergartenId: kgId,
      specialistType: input.specialistType,
      name: input.name,
      description: input.description ?? null,
      version: 1,
      isActive: true,
      schema: input.schema,
      createdBy: createdByStaffMemberId,
      createdAt: now,
      updatedAt: now,
    };
    const template = DiagnosticTemplate.fromState(state);
    return this.templates.create(template);
  }

  /**
   * PATCH name/description/schema. The entity's `update()` bumps `version`
   * iff the schema deeply differs from the previous one. We do NOT use a
   * conditional UPDATE (admin is the only writer + low contention); race
   * protection can be wired later via `findByIdForUpdate` if needed.
   */
  async update(
    kgId: string,
    id: string,
    patch: DiagnosticTemplateUpdatePatch,
  ): Promise<DiagnosticTemplate> {
    const existing = await this.templates.findById(kgId, id);
    if (existing === null) {
      throw new DiagnosticTemplateNotFoundError(id);
    }
    const updated = existing.update(patch, this.clock.now());
    return this.templates.update(updated);
  }

  /**
   * Soft-deactivate. Throws `InvariantViolationError('already_inactive')`
   * if the template is already inactive — `DomainErrorFilter` maps to 409.
   */
  async deactivate(kgId: string, id: string): Promise<DiagnosticTemplate> {
    const existing = await this.templates.findById(kgId, id);
    if (existing === null) {
      throw new DiagnosticTemplateNotFoundError(id);
    }
    const deactivated = existing.deactivate(this.clock.now());
    return this.templates.update(deactivated);
  }

  async list(
    kgId: string,
    filters: ListDiagnosticTemplatesFilter,
  ): Promise<DiagnosticTemplateListResult> {
    return this.templates.list(kgId, filters);
  }

  async getById(kgId: string, id: string): Promise<DiagnosticTemplate> {
    const existing = await this.templates.findById(kgId, id);
    if (existing === null) {
      throw new DiagnosticTemplateNotFoundError(id);
    }
    return existing;
  }
}
