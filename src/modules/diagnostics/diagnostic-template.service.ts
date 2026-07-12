import { randomUUID } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { SpecialistTypeService } from '@/modules/specialist-type/specialist-type.service';
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
  /**
   * B22b T5 / B18 L2 — orphaned-template audit channel. The presenter
   * batch path falls back to empty `template_name` on missing ids so a
   * page load never fails; the log marker `orphaned_diagnostic_entry`
   * is the only operator-visible signal that a dangling reference
   * slipped through.
   */
  private readonly logger = new Logger(DiagnosticTemplateService.name);

  constructor(
    private readonly templates: DiagnosticTemplateRepository,
    private readonly clock: ClockPort,
    // Optional so legacy spec wiring (which builds the service with two
    // args) keeps working. Required at HTTP-pipeline time because
    // `findStaffMemberByUserIdOrThrow` is called by every staff/admin
    // controller — failing closed (NotFoundException) when missing.
    private readonly staffMembers?: StaffMemberRepository,
    // Directory authority for `specialist_type`. Optional for the same
    // legacy-spec reason; when wired, `create` validates the template's
    // specialist_type against the ACTIVE directory.
    private readonly specialistTypes?: SpecialistTypeService,
  ) {}

  /**
   * Resolve a user → their active staff_members row in this kindergarten.
   * Centralised here so controllers no longer touch `StaffMemberRepository`
   * directly (CLAUDE.md §4: controllers stay thin HTTP-edge).
   *
   * Used by the admin / staff diagnostic-template controllers — `createdBy`
   * stamping (admin create), `specialist_type` filter (staff list).
   * Throws `NotFoundException('staff_member_not_found')` when:
   *   - the staff_members port is unwired (defensive guard for spec
   *     paths that build the service standalone), or
   *   - the user has no active staff_members row in this kg.
   */
  async findStaffMemberByUserIdOrThrow(
    kgId: string,
    userId: string,
  ): Promise<StaffMember> {
    if (!this.staffMembers) {
      throw new NotFoundException('staff_member_not_found');
    }
    const staffMember = await this.staffMembers.findActiveByUserAndKindergarten(
      userId,
      kgId,
    );
    if (!staffMember) {
      throw new NotFoundException('staff_member_not_found');
    }
    return staffMember;
  }

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
    // The template's specialist_type must be an ACTIVE directory code — this
    // is what "scopes diagnostics by type" references (specialist_type_unknown
    // → 400 otherwise).
    await this.specialistTypes?.assertUsableCode(kgId, input.specialistType);
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

  /**
   * Batch lookup used by presenters that need to join template `name` /
   * `version` onto a list of entries (B22b T5 / B18 M6). Returns a
   * `Map<id, template>` over the supplied ids, scoped to `kgId`. Missing
   * templates (deleted, cross-tenant, or simply absent) are NOT in the
   * map — the presenter falls back to empty `template_name` to keep the
   * list response intact instead of failing the whole page.
   *
   * Pure forwarder over `DiagnosticTemplateRepository.listByIds`; lives on
   * the service so controllers stay thin HTTP-edge (CLAUDE.md §4).
   */
  async listByIds(
    kgId: string,
    ids: string[],
  ): Promise<Map<string, DiagnosticTemplate>> {
    const map = await this.templates.listByIds(kgId, ids);
    // B22b T5 / B18 L2 — audit-log every dangling reference. The batch
    // path quietly drops missing ids so the presenter can render an
    // empty `template_name` instead of failing a whole page; without
    // this log line operators would never know the dangling reference
    // existed.
    if (map.size < ids.length) {
      const missing = ids.filter((id) => !map.has(id));
      for (const id of missing) {
        this.logger.error(
          `orphaned_diagnostic_entry kg=${kgId} template=${id}`,
        );
      }
    }
    return map;
  }
}
