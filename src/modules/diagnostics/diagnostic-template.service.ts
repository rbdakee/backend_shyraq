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
import { TemplateHasEntriesError } from './domain/errors/template-has-entries.error';
import { deepEqualJson, TemplateSchema } from './domain/schema-validators';

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
      // B22a T4 — optimistic-lock token starts at 1 (matches DB DEFAULT).
      rowVersion: 1,
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
   * PATCH name/description/schema. The entity's `update()` bumps the
   * semantic `version` iff the schema deeply differs from the previous
   * one (separate from the optimistic-lock `row_version` below).
   *
   * Race protection (B22a T4 — closes SM3 + B18 T6-M4): we capture
   * `existing.rowVersion` BEFORE applying the domain mutation and pass
   * it to the repo so the conditional UPDATE serialises concurrent
   * PATCHes. Late writers get `OptimisticLockError` (HTTP 409).
   *
   * Schema version-pinning (B22a T7 — closes H12): if `patch.schema` is
   * supplied AND structurally differs from the persisted schema AND
   * there is at least one persisted `diagnostic_entry` referencing this
   * template, throw `TemplateHasEntriesError` (HTTP 409
   * `template_has_entries`). The entry payloads are validated against
   * the live template schema on read; mutating the schema would silently
   * invalidate every prior entry. Non-schema patch fields (`name`,
   * `description`) remain editable in this state — the guard only fires
   * on a real structural diff.
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
    // H12: only pay the COUNT round-trip when the patch actually carries
    // a structural schema change. `deepEqualJson` short-circuits on the
    // common no-op-schema case (e.g. UI re-sending the same JSON object
    // alongside a renamed `name`).
    if (
      patch.schema !== undefined &&
      !deepEqualJson(existing.schema, patch.schema)
    ) {
      const entriesCount = await this.templates.countEntriesUsingTemplate(
        kgId,
        id,
      );
      if (entriesCount > 0) {
        throw new TemplateHasEntriesError(id, entriesCount);
      }
    }
    const expectedRowVersion = existing.rowVersion;
    const updated = existing.update(patch, this.clock.now());
    return this.templates.update(updated, expectedRowVersion);
  }

  /**
   * Soft-deactivate. Throws `InvariantViolationError('already_inactive')`
   * if the template is already inactive — `DomainErrorFilter` maps to 409.
   *
   * Race protection (B22a T4): same `expectedRowVersion` pattern as
   * `update()` — concurrent activate/deactivate flips against the same
   * loaded snapshot get one winner + 409 for the loser.
   */
  async deactivate(kgId: string, id: string): Promise<DiagnosticTemplate> {
    const existing = await this.templates.findById(kgId, id);
    if (existing === null) {
      throw new DiagnosticTemplateNotFoundError(id);
    }
    const expectedRowVersion = existing.rowVersion;
    const deactivated = existing.deactivate(this.clock.now());
    return this.templates.update(deactivated, expectedRowVersion);
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
