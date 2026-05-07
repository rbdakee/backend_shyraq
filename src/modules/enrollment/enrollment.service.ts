import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TariffAssignmentNotFoundError } from '@/modules/billing/domain/errors/tariff-assignment-not-found.error';
import { InvoiceService } from '@/modules/billing/invoice.service';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildService } from '@/modules/child/child.service';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Enrollment } from './domain/entities/enrollment.entity';
import { EnrollmentMissingRequiredFieldsError } from './domain/errors/enrollment-missing-required-fields.error';
import { EnrollmentNotFoundError } from './domain/errors/enrollment-not-found.error';
import { EnrollmentTransitionConflictError } from './domain/errors/enrollment-transition-conflict.error';
import { EnrollmentStatusLogEntry } from './domain/types/enrollment-status-log-entry';
import {
  EnrollmentStatus,
  EnrollmentStatusValue,
} from './domain/value-objects/enrollment-status.vo';
import { EnrollmentStatusLogRepository } from './infrastructure/persistence/enrollment-status-log.repository';
import { EnrollmentRepository } from './infrastructure/persistence/enrollment.repository';

export interface CreateEnrollmentInput {
  contactName: string;
  contactPhone: string;
  childName?: string;
  childDob?: Date;
  childIin?: string;
  source?: string;
  notes?: string;
  assignedTo?: string;
}

export interface UpdateEnrollmentPatch {
  contactName?: string;
  contactPhone?: string;
  childName?: string;
  childDob?: Date;
  childIin?: string;
  source?: string;
  notes?: string;
  assignedTo?: string;
}

export interface ListEnrollmentsQuery {
  status?: EnrollmentStatusValue;
  q?: string;
  page?: number;
  limit?: number;
}

export interface ListEnrollmentsResult {
  items: Enrollment[];
  total: number;
  page: number;
  limit: number;
}

export interface TransitionEnrollmentInput {
  toStatus: EnrollmentStatusValue;
  comment?: string;
  currentGroupId?: string;
}

export interface TransitionEnrollmentResult {
  enrollment: Enrollment;
  child?: Child;
}

export interface AssignEnrollmentInput {
  assignedTo: string;
}

/**
 * EnrollmentService — single entry point for the lead/inquiry aggregate (B5).
 *
 * Layout:
 *   - all admin/staff methods take an explicit `kindergartenId: string` and
 *     rely on the controller chain (JwtAuthGuard → KindergartenScopeGuard →
 *     RolesGuard) for role enforcement.
 *   - methods that need the calling user (transition, create-with-assignment)
 *     accept `callerUserId: string` (the JWT subject) and resolve it to the
 *     active staff_member of the kindergarten via StaffMemberRepository. The
 *     resolved `staff_member.id` becomes the actor on log entries / invites.
 *
 * Transactions:
 *   The service does NOT open its own `dataSource.transaction(...)`. The
 *   request is already running inside the ambient TX opened by
 *   `TenantContextInterceptor`, which also pushes the tenant-scoped
 *   `EntityManager` into AsyncLocalStorage. Both repos pick that manager up,
 *   so multi-step flows (notably `transition → card_created`, which creates a
 *   `children` row + a `child_guardians` row + updates `enrollments` + appends
 *   `enrollment_status_log`) are atomic without explicit wiring here.
 *
 * State machine and side-effects (B5 plan §3):
 *
 *     new           → in_processing
 *     in_processing → waitlist | card_created | cancelled
 *     waitlist      → in_processing
 *     card_created  → archive
 *     cancelled     → archive
 *     archive       → terminal
 *
 *   Only `card_created` carries side-effects: ChildService.createChild +
 *   ChildService.inviteGuardian + Enrollment.assignChild back-link.
 */
@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);

  constructor(
    private readonly enrollmentRepo: EnrollmentRepository,
    private readonly logRepo: EnrollmentStatusLogRepository,
    private readonly childService: ChildService,
    private readonly groupRepo: GroupRepository,
    private readonly staffRepo: StaffMemberRepository,
    private readonly invoiceService: InvoiceService,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  /**
   * Create a fresh enrollment in the `new` status. NB: initial creation does
   * NOT write an entry to `enrollment_status_log` — by plan §3 the log
   * captures *transitions only*, and `null → new` is implicit in the row's
   * own `created_at` column.
   */
  async create(
    kindergartenId: string,
    input: CreateEnrollmentInput,
    _callerUserId: string,
  ): Promise<Enrollment> {
    if (input.assignedTo !== undefined) {
      await this.assertStaffExists(kindergartenId, input.assignedTo);
    }
    const enrollment = Enrollment.createNew(
      {
        kindergartenId,
        contactName: input.contactName,
        contactPhone: input.contactPhone,
        childName: input.childName,
        childDob: input.childDob,
        childIin: input.childIin,
        source: input.source,
        notes: input.notes,
        assignedTo: input.assignedTo,
      },
      this.clock,
      () => randomUUID(),
    );
    return await this.enrollmentRepo.create(kindergartenId, enrollment);
  }

  /**
   * Patch lead-side fields. Domain rejects edits when the row is in a locked
   * status (card_created, cancelled, archive) via `EnrollmentLockedError`.
   * If `assignedTo` is touched, validate the staff member still exists in
   * the same kindergarten before persisting.
   */
  async update(
    kindergartenId: string,
    enrollmentId: string,
    patch: UpdateEnrollmentPatch,
  ): Promise<Enrollment> {
    const enrollment = await this.enrollmentRepo.findById(
      kindergartenId,
      enrollmentId,
    );
    if (!enrollment) throw new EnrollmentNotFoundError(enrollmentId);

    if (patch.assignedTo !== undefined) {
      await this.assertStaffExists(kindergartenId, patch.assignedTo);
    }
    enrollment.update(
      {
        contactName: patch.contactName,
        contactPhone: patch.contactPhone,
        childName: patch.childName,
        childDob: patch.childDob,
        childIin: patch.childIin,
        source: patch.source,
        notes: patch.notes,
        assignedTo: patch.assignedTo,
      },
      this.clock,
    );
    return await this.enrollmentRepo.update(kindergartenId, enrollment);
  }

  async getById(
    kindergartenId: string,
    enrollmentId: string,
  ): Promise<{ enrollment: Enrollment; log: EnrollmentStatusLogEntry[] }> {
    const enrollment = await this.enrollmentRepo.findById(
      kindergartenId,
      enrollmentId,
    );
    if (!enrollment) throw new EnrollmentNotFoundError(enrollmentId);
    const log = await this.logRepo.listForEnrollment(
      kindergartenId,
      enrollmentId,
    );
    return { enrollment, log };
  }

  async list(
    kindergartenId: string,
    query: ListEnrollmentsQuery,
  ): Promise<ListEnrollmentsResult> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const result = await this.enrollmentRepo.list(kindergartenId, {
      status: query.status,
      q: query.q,
      page,
      limit,
    });
    return { items: result.items, total: result.total, page, limit };
  }

  /**
   * Transition the enrollment along the state machine. The card_created edge
   * carries the heaviest side-effect: validate prerequisites up-front (so we
   * fail before the domain-level guard re-runs them), call
   * `ChildService.createChild` + `inviteGuardian`, then `assignChild` to link
   * the freshly-minted child back. Everything happens inside the ambient TX
   * — if `inviteGuardian` throws, the `children` insert plus all enrollment
   * mutations roll back together.
   */
  async transition(
    kindergartenId: string,
    enrollmentId: string,
    input: TransitionEnrollmentInput,
    callerUserId: string,
  ): Promise<TransitionEnrollmentResult> {
    const enrollment = await this.enrollmentRepo.findById(
      kindergartenId,
      enrollmentId,
    );
    if (!enrollment) throw new EnrollmentNotFoundError(enrollmentId);

    const callerStaffId = await this.resolveCallerStaffMemberId(
      kindergartenId,
      callerUserId,
    );

    const next = EnrollmentStatus.from(input.toStatus);

    if (next.equals(EnrollmentStatus.CARD_CREATED)) {
      this.validateCardCreatedPayload(enrollment, input);
      const group = await this.groupRepo.findById(
        kindergartenId,
        input.currentGroupId!,
      );
      if (!group) throw new GroupNotFoundError(input.currentGroupId!);
    }

    // Capture the old status BEFORE the in-memory transition so the
    // conditional UPDATE below can guard against a concurrent transition
    // that already moved the row.
    const oldStatus = enrollment.status.value;

    const { logEntry } = enrollment.transitionTo(
      next,
      callerStaffId,
      input.comment ?? null,
      this.clock,
    );

    let child: Child | undefined;
    if (next.equals(EnrollmentStatus.CARD_CREATED)) {
      child = await this.childService.createChild(kindergartenId, {
        fullName: enrollment.childName!,
        iin: enrollment.childIin ?? undefined,
        dateOfBirth: enrollment.childDob!,
        currentGroupId: input.currentGroupId!,
      });
      await this.childService.inviteGuardian(kindergartenId, {
        childId: child.id,
        userPhone: enrollment.contactPhone,
        role: 'primary',
        canPickup: true,
        invitedByUserId: callerUserId,
      });
      enrollment.assignChild(child.id, this.clock);

      // B13 cross-module hook: emit the first-month invoice on card_created.
      // Runs on the ambient HTTP TX opened by TenantContextInterceptor.
      //
      // NB: a `tariff_assignment` row REQUIRES `child_id`, which only exists
      // after `createChild` above. The admin therefore cannot pre-assign a
      // tariff before the very first transition — strict mode would make the
      // happy path impossible. Lax mode: if no active assignment is found we
      // log + skip; the admin attaches a tariff via
      // `POST /admin/tariff-assignments` afterwards, and the next monthly
      // cron picks the child up. Other failures (DB errors, misconfigured
      // tariff_plan, etc.) still propagate and roll back the ambient TX.
      const enrollmentDate = this.clock.now();
      try {
        const firstInvoice = await this.invoiceService.generateFirstInvoice(
          kindergartenId,
          {
            childId: child.id,
            enrollmentDate,
            assignedBy: callerStaffId,
          },
        );
        this.logger.log(
          `enrollment.first_invoice_generated invoice=${firstInvoice.id} child=${child.id} kg=${kindergartenId}`,
        );
      } catch (err) {
        if (err instanceof TariffAssignmentNotFoundError) {
          this.logger.warn(
            `enrollment.first_invoice_skipped reason=tariff_assignment_not_found child=${child.id} kg=${kindergartenId}`,
          );
        } else {
          throw err;
        }
      }
    }

    // Status-guarded UPDATE: 0 rows affected means another caller already
    // transitioned the enrollment. Throwing here aborts the ambient TX,
    // rolling back any `createChild` + `inviteGuardian` writes performed
    // moments earlier — without this guard, two concurrent card_created
    // transitions would both create children for the same enrollment.
    const written = await this.enrollmentRepo.updateWithExpectedStatus(
      kindergartenId,
      enrollment,
      oldStatus,
    );
    if (!written) {
      throw new EnrollmentTransitionConflictError(
        enrollment.id,
        oldStatus,
        next.value,
      );
    }
    await this.logRepo.append(kindergartenId, logEntry);

    // Re-read to surface the post-write row (mirrors the legacy
    // `update().return-row` contract callers expect).
    const updated = await this.enrollmentRepo.findById(
      kindergartenId,
      enrollment.id,
    );
    if (!updated) {
      // Should be impossible — we just wrote under the same RLS scope.
      throw new EnrollmentNotFoundError(enrollment.id);
    }

    return child === undefined
      ? { enrollment: updated }
      : { enrollment: updated, child };
  }

  /**
   * Reassign the lead to a different staff member. Domain rejects the call
   * when the lead is in a terminal status (`archive`) via
   * `EnrollmentLockedError`.
   */
  async assign(
    kindergartenId: string,
    enrollmentId: string,
    input: AssignEnrollmentInput,
  ): Promise<Enrollment> {
    const enrollment = await this.enrollmentRepo.findById(
      kindergartenId,
      enrollmentId,
    );
    if (!enrollment) throw new EnrollmentNotFoundError(enrollmentId);

    await this.assertStaffExists(kindergartenId, input.assignedTo);
    enrollment.assignTo(input.assignedTo, this.clock);
    return await this.enrollmentRepo.update(kindergartenId, enrollment);
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async assertStaffExists(
    kindergartenId: string,
    staffMemberId: string,
  ): Promise<void> {
    const staff = await this.staffRepo.findById(kindergartenId, staffMemberId);
    if (!staff) throw new StaffNotFoundError(staffMemberId);
  }

  /**
   * Resolve the calling user's active `staff_members.id` in this
   * kindergarten. Used as the `changed_by` actor on log entries. We treat a
   * missing staff record as `StaffNotFoundError(userId)` — the caller is not
   * authorized to act on this tenant even if their JWT validated.
   */
  private async resolveCallerStaffMemberId(
    kindergartenId: string,
    callerUserId: string,
  ): Promise<string> {
    const staff = await this.staffRepo.findActiveByUserAndKindergarten(
      callerUserId,
      kindergartenId,
    );
    if (!staff) throw new StaffNotFoundError(callerUserId);
    return staff.id;
  }

  /**
   * Service-level pre-check for the card_created edge. The same conditions
   * are re-asserted by `Enrollment.transitionTo`, but we want to fail before
   * we start touching ChildService — so the missingFields list (including
   * the service-only `currentGroupId`) is collected here.
   */
  private validateCardCreatedPayload(
    enrollment: Enrollment,
    input: TransitionEnrollmentInput,
  ): void {
    const missing: string[] = [];
    if (!enrollment.childName || enrollment.childName.trim().length === 0) {
      missing.push('childName');
    }
    if (enrollment.childDob === null) {
      missing.push('childDob');
    }
    if (!enrollment.contactName || enrollment.contactName.trim().length === 0) {
      missing.push('contactName');
    }
    if (
      !enrollment.contactPhone ||
      enrollment.contactPhone.trim().length === 0
    ) {
      missing.push('contactPhone');
    }
    if (input.currentGroupId === undefined) {
      missing.push('currentGroupId');
    }
    if (missing.length > 0) {
      throw new EnrollmentMissingRequiredFieldsError(missing);
    }
  }
}
