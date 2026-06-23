import { randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildService } from '@/modules/child/child.service';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { SpecialistType } from '@/modules/staff/domain/value-objects/specialist-type.vo';
import { StaffService } from '@/modules/staff/staff.service';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { NannyNoDiagnosticsAccessError } from './domain/errors/nanny-no-diagnostics-access.error';
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

/** Returns the trimmed value, or null when empty/whitespace-only/absent. */
function nonBlankOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Identity overlay for a diagnostic-entry specialist — `specialist_id`
 * resolved to a display name (staff identity fallback
 * `staff_members.full_name ?? users.full_name`) plus the staff member's
 * `specialist_type` (D4 whitelist). Both null when the staff row is missing
 * or the staff ports are not wired (legacy spec construction).
 */
export interface SpecialistOverlay {
  fullName: string | null;
  specialistType: SpecialistType | null;
}

@Injectable()
export class DiagnosticEntryService {
  /**
   * B22b T5 / B18 L2 — orphaned-entry audit channel. Surfaces every
   * encountered orphan (entry whose `template_id` resolves to nothing
   * in the same tenant) at `error` level so an operator scanning logs
   * can correlate the entry id with whatever flow exposed it (PATCH,
   * single-GET, list). Marker `orphaned_diagnostic_entry` is grep-able.
   */
  private readonly logger = new Logger(DiagnosticEntryService.name);

  constructor(
    private readonly templates: DiagnosticTemplateRepository,
    private readonly entries: DiagnosticEntryRepository,
    private readonly children: ChildRepository,
    private readonly notification: NotificationPort,
    private readonly clock: ClockPort,
    // Optional so older spec wiring (which builds the service standalone
    // without StaffModule wired in) keeps working. Used by
    // `findStaffMemberByUserIdOrThrow` and `resolveSpecialists` — fails
    // closed when missing.
    private readonly staffMembers?: StaffMemberRepository,
    // Optional for the same reason — the parent-side permission gate
    // is the only consumer.
    private readonly childGuardians?: ChildGuardianRepository,
    // Optional for the same reason. Used by `resolveSpecialists` to
    // reuse the staff identity fallback (`staff_members.full_name ??
    // users.full_name`). When missing, name resolution fails closed →
    // `specialist_full_name = null`.
    private readonly staffService?: StaffService,
    // Optional for the same reason — used by `resolveChildNames` for the
    // staff `child_name` overlay (children.id → children.full_name, incl.
    // archived). When missing (legacy positional spec wiring), name
    // resolution fails closed → empty map → `child_name = null`.
    private readonly childService?: ChildService,
  ) {}

  /**
   * Identity overlay for diagnostic-entry lists — resolves each entry's
   * `specialist_id` (a `staff_members.id`) to a display name via the staff
   * identity fallback (`staff_members.full_name ?? users.full_name`) plus the
   * staff member's `specialist_type`. Mirrors
   * `ProgressNoteService.resolveMentorNames`: distinct `specialist_id`s are
   * looked up once and returned as a map keyed by `specialist_id`.
   *
   * Blank/whitespace-only names collapse to null so the client can fall back
   * cleanly. Fails closed: if the staff ports are not wired (legacy spec
   * construction) or a specialist row is missing, that entry resolves to
   * `{ fullName: null, specialistType: null }`.
   */
  async resolveSpecialists(
    kgId: string,
    entries: DiagnosticEntry[],
  ): Promise<Map<string, SpecialistOverlay>> {
    const out = new Map<string, SpecialistOverlay>();
    if (!this.staffMembers || !this.staffService) {
      return out;
    }
    const distinctSpecialistIds = [
      ...new Set(entries.map((e) => e.specialistId)),
    ];
    for (const specialistId of distinctSpecialistIds) {
      const member = await this.staffMembers.findById(kgId, specialistId);
      if (!member) {
        out.set(specialistId, { fullName: null, specialistType: null });
        continue;
      }
      const identity = await this.staffService.resolveIdentity(member);
      out.set(specialistId, {
        fullName: nonBlankOrNull(identity.fullName),
        specialistType: member.toState().specialistType,
      });
    }
    return out;
  }

  /**
   * Identity overlay for diagnostic-entry `child_name` — resolves each entry's
   * `child_id` to `children.full_name` (INCLUDING archived children) within the
   * caller kg, batched + deduped, via `ChildService.resolveChildNames`. Mirrors
   * `resolveSpecialists`. Returns a `Map<childId, full_name>`; ids missing from
   * the map (missing / cross-tenant child rows) render `child_name` as null.
   * Fails closed to an empty map when the `ChildService` port is not wired
   * (legacy positional spec construction).
   */
  async resolveChildNames(
    kindergartenId: string,
    entries: DiagnosticEntry[],
  ): Promise<Map<string, string>> {
    if (!this.childService) {
      return new Map();
    }
    return this.childService.resolveChildNames(
      kindergartenId,
      entries.map((e) => e.childId),
    );
  }

  /**
   * Resolve a user → their active staff_members row in this kindergarten.
   * Pulled here from the diagnostic controllers (CLAUDE.md §4 — controllers
   * stay thin HTTP-edge). Throws `NotFoundException('staff_member_not_found')`
   * when the user has no active row in this kg.
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
   * Parent-side permission gate (BP §8.5): caller must be an approved-active
   * guardian of `:childId` AND have `view_diagnostics = true`.
   * `ChildAccessGuard` already validates the cross-tenant approved status —
   * this method re-validates explicitly to also surface the permission flag
   * (nanny defaults to `view_diagnostics=false`).
   *
   * Throws:
   *   - `ForbiddenException('not_a_guardian')` — defensive re-check.
   *   - `NannyNoDiagnosticsAccessError` — guardian has the link but
   *     `view_diagnostics=false` (nanny role, or primary revoked the
   *     permission on a secondary's row).
   */
  async assertParentCanViewDiagnostics(
    kgId: string,
    userId: string,
    childId: string,
  ): Promise<void> {
    if (!this.childGuardians) {
      throw new ForbiddenException('not_a_guardian');
    }
    const guardian = await this.childGuardians.findApprovedActiveByUserAndChild(
      kgId,
      childId,
      userId,
    );
    if (!guardian) {
      throw new ForbiddenException('not_a_guardian');
    }
    const effective = guardian.permissions.effective(guardian.role);
    if (!effective.view_diagnostics) {
      throw new NannyNoDiagnosticsAccessError();
    }
  }

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
        //
        // B22b T5 / B18 L2 — log the orphan BEFORE rethrowing so the
        // operator gets a grep-able trail (`orphaned_diagnostic_entry`)
        // tied to both the entry id and the dangling template id. The
        // generic 404 the caller sees doesn't carry that diagnostic
        // payload — the log line is the audit trail.
        this.logger.error(
          `orphaned_diagnostic_entry kg=${kgId} entry=${id} template=${existing.templateId}`,
        );
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

  /**
   * Parent-scoped variant of `getById`. Loads the entry by id within the
   * tenant AND asserts that `entry.childId === expectedChildId`. Returns
   * 404 (`diagnostic_entry_not_found`) on cross-child mismatch — same
   * shape as a missing row so we don't leak whether `entryId` exists for
   * a sibling family.
   *
   * Closes FINDINGS M1 (B22a T8): the parent-side controller previously
   * called `getById(kgId, entryId)` and trusted the URL `:childId` for
   * authorization without checking it matched the loaded entry's child.
   * A parent of child A could request `/parent/children/{A}/diagnostics/{entryB}`
   * and receive child B's entry — IDOR. This method binds the entry
   * lookup to the URL child so the controller's permission check
   * (which is keyed on `:childId`) becomes the actual authorization
   * boundary.
   */
  async getByIdForChild(
    kgId: string,
    expectedChildId: string,
    id: string,
  ): Promise<DiagnosticEntry> {
    const existing = await this.entries.findById(kgId, id);
    if (existing === null || existing.childId !== expectedChildId) {
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
