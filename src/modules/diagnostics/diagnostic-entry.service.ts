import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { formatDateInTimezone } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { DiagnosticTemplateRepository } from './diagnostic-template.repository';
import {
  DiagnosticEntryListResult,
  DiagnosticEntryRepository,
  ListDiagnosticEntriesFilter,
} from './diagnostic-entry.repository';
import {
  DiagnosticEntry,
  DiagnosticEntryState,
  DiagnosticEntryUpdatePatch,
} from './domain/entities/diagnostic-entry.entity';
import { DiagnosticEntryNotFoundError } from './domain/errors/diagnostic-entry-not-found.error';
import { DiagnosticTemplateInactiveError } from './domain/errors/diagnostic-template-inactive.error';
import { DiagnosticTemplateNotFoundError } from './domain/errors/diagnostic-template-not-found.error';
import { validateEntryData } from './domain/schema-validators';

export interface CreateDiagnosticEntryInput {
  childId: string;
  templateId: string;
  specialistId: string;
  assessmentDate: Date;
  data: Record<string, unknown>;
  summary?: string | null;
  recommendations?: string | null;
  attachments?: string[];
}

@Injectable()
export class DiagnosticEntryService {
  constructor(
    private readonly templates: DiagnosticTemplateRepository,
    private readonly entries: DiagnosticEntryRepository,
    private readonly children: ChildRepository,
    private readonly notification: NotificationPort,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Create a new entry against an existing, active template. Validates the
   * `data` payload against `template.schema` BEFORE persisting, then emits
   * `diagnostic.new` for guardian fan-out via the dispatcher.
   *
   * Errors:
   *   404 `not_found` (child)             — bad childId / cross-tenant child.
   *                                          (`ChildNotFoundError` extends
   *                                          `NotFoundError` whose code is the
   *                                          generic `not_found`; message body:
   *                                          `child not found: <id>`).
   *   404 `diagnostic_template_not_found` — bad templateId / cross-tenant.
   *   409 `diagnostic_template_inactive`  — template is deactivated.
   *   400 `diagnostic_entry_data_invalid` — data violates template schema.
   *   400 `assessment_date_in_future`     — entity invariant.
   *
   * Tenant-scoped child existence check is service-side defense-in-depth
   * against cross-tenant child_id reference (see B18 T7 review). RLS already
   * blocks reading the child row across tenants, but `children` does not yet
   * have a composite UNIQUE `(kindergarten_id, id)` to enforce a same-tenant
   * FK from `diagnostic_entries.child_id` (deferred to B22). Until then the
   * service-layer guard is the single line of defense.
   */
  async create(
    kgId: string,
    input: CreateDiagnosticEntryInput,
  ): Promise<DiagnosticEntry> {
    const child = await this.children.findById(kgId, input.childId);
    if (child === null) {
      throw new ChildNotFoundError(input.childId);
    }
    const template = await this.templates.findById(kgId, input.templateId);
    if (template === null) {
      throw new DiagnosticTemplateNotFoundError(input.templateId);
    }
    if (!template.isActive) {
      throw new DiagnosticTemplateInactiveError(input.templateId);
    }
    validateEntryData(template.schema, input.data);

    const now = this.clock.now();
    const state: DiagnosticEntryState = {
      id: randomUUID(),
      kindergartenId: kgId,
      childId: input.childId,
      templateId: input.templateId,
      specialistId: input.specialistId,
      assessmentDate: input.assessmentDate,
      data: input.data,
      summary: input.summary ?? null,
      recommendations: input.recommendations ?? null,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
      createdAt: now,
      updatedAt: now,
      // B22a T4 — optimistic-lock token starts at 1 (matches DB DEFAULT).
      rowVersion: 1,
    };
    const entry = DiagnosticEntry.fromState(state, now);
    const persisted = await this.entries.create(entry);

    // Emit AFTER successful insert. The outbox row commits atomically with
    // the business INSERT thanks to the ambient TX from
    // `TenantContextInterceptor`; if the dispatcher is not yet wired this
    // is still safe — the row sits in `notification_outbox` until the
    // poller picks it up.
    await this.notification.notifyDiagnosticNew({
      kindergartenId: kgId,
      childId: persisted.childId,
      entryId: persisted.id,
      templateId: persisted.templateId,
      templateName: template.name,
      specialistId: persisted.specialistId,
      specialistType: template.specialistType,
      // B18 T6-M7: assessment_date is a PG `date` column round-tripped as
      // a midnight-UTC Date. Under Asia/Almaty contract we format in
      // Asia/Almaty so the YYYY-MM-DD matches the staff-input wall-clock.
      assessmentDate: formatDateInTimezone(persisted.assessmentDate),
      createdAt: persisted.createdAt,
    });

    return persisted;
  }

  /**
   * PATCH entry. Author-only (`assertAuthoredBy` throws 403 on mismatch);
   * admin override is handled at the controller layer (T4) by passing the
   * caller's specialist_member_id == entry.specialistId so the assertion
   * passes for admins too. If `data` is patched, re-validate against the
   * template stored on the entry (NOT a new templateId — entries are bound
   * to a single template per BP §8.4).
   *
   * Race protection (B22a T4 — closes B18 T6-M4): `expectedRowVersion`
   * captured BEFORE the domain mutation; concurrent PATCHes serialise
   * via the conditional UPDATE in the relational repo. Late writers
   * receive `OptimisticLockError` (HTTP 409).
   *
   * Audit stamping (B22a T7 — closes B18 Concern 1): `callerUserId` is
   * the caller's `users.id` (not their `staff_members.id`) — surfaces
   * the admin-override audit trail at the user-identity layer so we
   * can follow it across staff_member churn (terminate + re-add in
   * different role would break a staff_member-FK link). Stamped on
   * `last_modified_by_user_id` + `last_modified_at` columns alongside
   * the business-field updates inside the same conditional UPDATE.
   */
  async update(
    kgId: string,
    id: string,
    callerStaffMemberId: string,
    callerUserId: string,
    patch: DiagnosticEntryUpdatePatch,
  ): Promise<DiagnosticEntry> {
    const existing = await this.entries.findById(kgId, id);
    if (existing === null) {
      throw new DiagnosticEntryNotFoundError(id);
    }
    existing.assertAuthoredBy(callerStaffMemberId);

    if (patch.data !== undefined) {
      const template = await this.templates.findById(kgId, existing.templateId);
      if (template === null) {
        // Should be unreachable — FK + RLS guarantee the template exists.
        // Surface as 404 if it ever hits.
        throw new DiagnosticTemplateNotFoundError(existing.templateId);
      }
      validateEntryData(template.schema, patch.data);
    }

    const expectedRowVersion = existing.rowVersion;
    const now = this.clock.now();
    const updated = existing.update(
      {
        ...patch,
        lastModifiedByUserId: callerUserId,
        lastModifiedAt: now,
      },
      now,
    );
    return this.entries.update(updated, expectedRowVersion);
  }

  async getById(kgId: string, id: string): Promise<DiagnosticEntry> {
    const existing = await this.entries.findById(kgId, id);
    if (existing === null) {
      throw new DiagnosticEntryNotFoundError(id);
    }
    return existing;
  }

  async listByChild(
    kgId: string,
    childId: string,
    filters: { from?: Date; to?: Date; cursor?: string; limit: number },
  ): Promise<DiagnosticEntryListResult> {
    return this.entries.list(kgId, { ...filters, childId });
  }

  async listByKgFiltered(
    kgId: string,
    filters: ListDiagnosticEntriesFilter,
  ): Promise<DiagnosticEntryListResult> {
    return this.entries.list(kgId, filters);
  }
}
