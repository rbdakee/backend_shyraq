import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { AllConfigType } from '@/config/config.type';
import { tenantStorage } from '@/database/tenant-storage';
import { OtpStorePort } from '@/modules/auth/otp-store.port';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import { UserRepository } from '@/modules/users/infrastructure/persistence/user.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { NotFoundError } from '@/shared-kernel/domain/errors';
import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { GuardianPermissions } from '@/shared-kernel/domain/value-objects/guardian-permissions.vo';
import {
  GuardianRelation,
  GuardianRelationValue,
} from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { GuardianStatus } from '@/shared-kernel/domain/value-objects/guardian-status.vo';
import { Iin } from '@/shared-kernel/domain/value-objects/iin.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { Phone } from '@/shared-kernel/domain/value-objects/phone.vo';
import { UserId } from '@/shared-kernel/domain/value-objects/user-id.vo';
import { ChildGuardianRepository } from './infrastructure/persistence/child-guardian.repository';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from './infrastructure/persistence/child.repository';
import { Child, Gender } from './domain/entities/child.entity';
import { ChildGuardian } from './domain/entities/child-guardian.entity';
import { AlreadyLinkedToChildError } from './domain/errors/already-linked-to-child.error';
import { AlreadyPendingForChildError } from './domain/errors/already-pending-for-child.error';
import { ChildAccessDeniedError } from './domain/errors/child-access-denied.error';
import { ChildIinAlreadyExistsError } from './domain/errors/child-iin-already-exists.error';
import { ChildNotFoundError } from './domain/errors/child-not-found.error';
import { ChildNotFoundForIinError } from './domain/errors/child-not-found-for-iin.error';
import { DuplicateGuardianError } from './domain/errors/duplicate-guardian.error';
import { GuardianNotFoundError } from './domain/errors/guardian-not-found.error';
import { MaxApprovalRightsExceededError } from './domain/errors/max-approval-rights-exceeded.error';
import { MultipleChildrenForIinError } from './domain/errors/multiple-children-for-iin.error';
import { NotPrimaryGuardianError } from './domain/errors/not-primary-guardian.error';
import { ParentLinkRateLimitError } from './domain/errors/parent-link-rate-limit.error';
import { PrimaryCannotSelfRevokeError } from './domain/errors/primary-cannot-self-revoke.error';

export interface CreateChildInput {
  fullName: string;
  iin?: string;
  dateOfBirth: Date;
  gender?: Gender;
  photoUrl?: string;
  currentGroupId?: string;
  medicalNotes?: string;
  allergyNotes?: string;
}

export interface UpdateChildPatch {
  fullName?: string;
  iin?: string | null;
  dateOfBirth?: Date;
  gender?: Gender | null;
  photoUrl?: string | null;
  medicalNotes?: string | null;
  allergyNotes?: string | null;
}

export interface InviteGuardianInput {
  childId: string;
  userPhone?: string;
  userId?: string;
  role: GuardianRelationValue;
  canPickup?: boolean;
  invitedByUserId: string;
}

export interface ChildWithGuardians {
  child: Child;
  guardians: ChildGuardian[];
}

export interface LinkChildByIinInput {
  iin: string;
  role: 'secondary' | 'nanny';
  canPickup?: boolean;
}

export interface LinkChildByIinResult {
  guardian: ChildGuardian;
  child: Child;
}

const KG_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * ChildService — single entry point for the child + child_guardian aggregate.
 *
 * Layout:
 *   - admin / staff methods take an explicit `kindergartenId: string` and rely
 *     on the controller chain (JwtAuthGuard → KindergartenScopeGuard →
 *     RolesGuard) for role enforcement.
 *   - parent methods take `kindergartenId` AND the calling user id; they
 *     re-check that the caller is an APPROVED PRIMARY guardian of the affected
 *     child as defense-in-depth around ChildAccessGuard.
 *
 * Guardian state machine (per ChildGuardian aggregate):
 *
 *     created → pending_approval ──approve──▶ approved ──revoke──▶ revoked
 *                          │                       │
 *                          └──reject──▶ rejected   └──reset/permissions
 *                          │
 *                          └──admin revoke──▶ revoked
 *
 * Approve/reject must be issued from `pending_approval`; admin / primary
 * revoke is allowed from `pending_approval` or `approved`. Permission patches
 * require `approved`. The has_approval_rights flag is capped at ≤2 per child
 * via a race-free read+check inside this service.
 */
@Injectable()
export class ChildService {
  constructor(
    private readonly children: ChildRepository,
    private readonly guardians: ChildGuardianRepository,
    private readonly groups: GroupRepository,
    private readonly staff: StaffMemberRepository,
    private readonly users: UserRepository,
    @Inject(NotificationPort) private readonly notification: NotificationPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OtpStorePort) private readonly otpStore: OtpStorePort,
    private readonly configService: ConfigService<AllConfigType>,
  ) {}

  // ── Children: admin reads / writes ──────────────────────────────────────

  async createChild(
    kindergartenId: string,
    input: CreateChildInput,
  ): Promise<Child> {
    const kgId = KindergartenId.parse(kindergartenId);
    const iin = input.iin !== undefined ? Iin.parse(input.iin) : undefined;

    if (input.currentGroupId !== undefined) {
      const group = await this.groups.findById(
        kindergartenId,
        input.currentGroupId,
      );
      if (!group) throw new GroupNotFoundError(input.currentGroupId);
    }
    if (iin !== undefined) {
      const existing = await this.children.findByKindergartenAndIin(
        kindergartenId,
        iin.toString(),
      );
      if (existing) throw new ChildIinAlreadyExistsError(iin.toString());
    }

    const child = Child.createNew({
      id: ChildId.parse(randomUUID()),
      kindergartenId: kgId,
      fullName: input.fullName,
      iin,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
      photoUrl: input.photoUrl,
      currentGroupId: input.currentGroupId,
      medicalNotes: input.medicalNotes,
      allergyNotes: input.allergyNotes,
      now: this.clock.now(),
    });
    await this.children.create(child);
    return child;
  }

  async getChild(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildWithGuardians> {
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    const guardians = await this.guardians.findByChildId(
      kindergartenId,
      childId,
    );
    return { child, guardians };
  }

  listChildren(
    kindergartenId: string,
    filters: ChildListFilters,
    page: PageRequest,
  ): Promise<PageResult<Child>> {
    return this.children.list(kindergartenId, filters, page);
  }

  async updateChildProfile(
    kindergartenId: string,
    childId: string,
    patch: UpdateChildPatch,
  ): Promise<Child> {
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);

    let parsedIin: Iin | null | undefined;
    if (patch.iin !== undefined) {
      if (patch.iin === null) {
        parsedIin = null;
      } else {
        parsedIin = Iin.parse(patch.iin);
        const conflict = await this.children.findByKindergartenAndIin(
          kindergartenId,
          parsedIin.toString(),
        );
        if (conflict && conflict.id !== child.id) {
          throw new ChildIinAlreadyExistsError(parsedIin.toString());
        }
      }
    }

    child.updateProfile(
      {
        fullName: patch.fullName,
        iin: parsedIin,
        dateOfBirth: patch.dateOfBirth,
        gender: patch.gender,
        photoUrl: patch.photoUrl,
        medicalNotes: patch.medicalNotes,
        allergyNotes: patch.allergyNotes,
      },
      this.clock.now(),
    );
    await this.children.update(child);
    return child;
  }

  async updateChildPhoto(
    kindergartenId: string,
    childId: string,
    photoUrl: string | null,
  ): Promise<Child> {
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    child.updatePhoto(photoUrl, this.clock.now());
    await this.children.update(child);
    return child;
  }

  async assignChildToGroup(
    kindergartenId: string,
    childId: string,
    groupId: string,
  ): Promise<Child> {
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    const group = await this.groups.findById(kindergartenId, groupId);
    if (!group) throw new GroupNotFoundError(groupId);
    child.assignToGroup(groupId, this.clock.now());
    await this.children.update(child);
    return child;
  }

  async unassignChildFromGroup(
    kindergartenId: string,
    childId: string,
  ): Promise<Child> {
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    child.unassignFromGroup(this.clock.now());
    await this.children.update(child);
    return child;
  }

  /**
   * Transfer a child to a new group, atomically appending a child_group_history
   * row with the staff member who initiated the transfer. Throws
   * `GroupTransferToSelfError` if the target group equals the current group.
   */
  async transferChildToGroup(
    kindergartenId: string,
    childId: string,
    toGroupId: string,
    transferredByStaffId: string,
    reason: string | null = null,
  ): Promise<Child> {
    const kgId = KindergartenId.parse(kindergartenId);
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    const target = await this.groups.findById(kindergartenId, toGroupId);
    if (!target) throw new GroupNotFoundError(toGroupId);

    const now = this.clock.now();
    const { fromGroupId, toGroupId: toId } = child.transferToGroup(
      toGroupId,
      now,
    );
    await this.children.update(child);
    await this.children.recordGroupTransfer(
      kindergartenId,
      childId,
      fromGroupId,
      toId,
      transferredByStaffId,
      reason,
      now,
    );

    const allGuardians = await this.guardians.findByChildId(
      kindergartenId,
      childId,
    );
    const recipientUserIds = allGuardians
      .filter((g) => g.status.equals(GuardianStatus.APPROVED))
      .map((g) => g.userId as string);
    await this.notification.notifyChildTransferred({
      kindergartenId: kgId,
      childId,
      fromGroupId,
      toGroupId: toId,
      transferredBy: transferredByStaffId,
      recipientUserIds,
    });
    return child;
  }

  async listChildGroupHistory(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGroupHistoryRecord[]> {
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    return this.children.listGroupHistory(kindergartenId, childId);
  }

  async archiveChild(
    kindergartenId: string,
    childId: string,
    reason = '',
  ): Promise<Child> {
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    child.archive(reason, this.clock.now());
    await this.children.update(child);
    return child;
  }

  async restoreChild(kindergartenId: string, childId: string): Promise<Child> {
    const child = await this.children.findById(kindergartenId, childId);
    if (!child) throw new ChildNotFoundError(childId);
    child.restore(this.clock.now());
    await this.children.update(child);
    return child;
  }

  // ── Guardians: admin path ───────────────────────────────────────────────

  /**
   * Admin invites a guardian for the child. Resolves user via phone (find or
   * create) or by user id. Inserts a `pending_approval` row and notifies any
   * approved primary guardian. Exactly one of (userPhone, userId) must be set.
   */
  async inviteGuardian(
    kindergartenId: string,
    input: InviteGuardianInput,
  ): Promise<ChildGuardian> {
    if ((input.userPhone === undefined) === (input.userId === undefined)) {
      throw new Error(
        'inviteGuardian: provide exactly one of userPhone or userId',
      );
    }
    const kgId = KindergartenId.parse(kindergartenId);
    const childId = ChildId.parse(input.childId);
    const child = await this.children.findById(kindergartenId, input.childId);
    if (!child) throw new ChildNotFoundError(input.childId);

    let userId: UserId;
    if (input.userPhone !== undefined) {
      const phone = Phone.parse(input.userPhone);
      const existing = await this.users.findByPhone(phone.toString());
      if (existing) {
        userId = UserId.parse(existing.id);
      } else {
        const created = await this.users.upsertByPhone(phone.toString());
        userId = UserId.parse(created.id);
      }
    } else {
      userId = UserId.parse(input.userId!);
      const u = await this.users.findById(userId);
      if (!u) throw new NotFoundError('user', userId);
    }

    const dup = await this.guardians.findActiveByChildAndUser(
      kindergartenId,
      input.childId,
      userId,
    );
    if (dup) throw new DuplicateGuardianError(input.childId, userId);

    const role = GuardianRelation.fromString(input.role);
    const guardian = ChildGuardian.createPending({
      id: randomUUID(),
      kindergartenId: kgId,
      childId,
      userId,
      role,
      canPickup: input.canPickup,
      now: this.clock.now(),
    });
    await this.guardians.create(guardian);

    const allGuardians = await this.guardians.findByChildId(
      kindergartenId,
      input.childId,
    );
    const primary = allGuardians.find(
      (g) =>
        g.role.equals(GuardianRelation.PRIMARY) &&
        g.status.equals(GuardianStatus.APPROVED),
    );
    if (primary) {
      await this.notification.notifyGuardianPendingApproval({
        kindergartenId: kgId,
        childId,
        childFullName: child.fullName,
        primaryUserId: primary.userId,
        requesterUserId: input.invitedByUserId,
        role: input.role,
      });
    }
    return guardian;
  }

  listChildGuardians(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGuardian[]> {
    return this.guardians.findByChildId(kindergartenId, childId);
  }

  /**
   * Admin updates role and/or can_pickup. Disallowed on revoked rows. Cross-id
   * defense: if the guardian record points to a different child than the URL
   * suggests, the call resolves to GuardianNotFoundError.
   */
  async updateGuardianRoleAndPickup(
    kindergartenId: string,
    childId: string,
    guardianId: string,
    patch: { role?: GuardianRelationValue; canPickup?: boolean },
  ): Promise<ChildGuardian> {
    const guardian = await this.guardians.findById(kindergartenId, guardianId);
    if (!guardian || guardian.childId !== ChildId.parse(childId)) {
      throw new GuardianNotFoundError(guardianId);
    }
    guardian.updateRoleAndPickup(
      {
        role:
          patch.role !== undefined
            ? GuardianRelation.fromString(patch.role)
            : undefined,
        canPickup: patch.canPickup,
      },
      this.clock.now(),
    );
    await this.guardians.update(guardian);
    return guardian;
  }

  /** Admin revoke. Sets revoked_at + revoked_by = the calling staff user id. */
  async revokeGuardianByAdmin(
    kindergartenId: string,
    childId: string,
    guardianId: string,
    revokedByUserId: string,
  ): Promise<ChildGuardian> {
    const kgId = KindergartenId.parse(kindergartenId);
    const guardian = await this.guardians.findById(kindergartenId, guardianId);
    if (!guardian || guardian.childId !== ChildId.parse(childId)) {
      throw new GuardianNotFoundError(guardianId);
    }
    const by = UserId.parse(revokedByUserId);
    guardian.revoke(by, this.clock.now());
    await this.guardians.update(guardian);
    await this.notification.notifyGuardianRevoked({
      kindergartenId: kgId,
      childId: guardian.childId,
      guardianUserId: guardian.userId,
      revokedBy: revokedByUserId,
    });
    return guardian;
  }

  // ── Guardians: parent path ──────────────────────────────────────────────

  /**
   * Parent (approved primary) approves a pending guardian. Optionally grants
   * has_approval_rights — capped at ≤2 per child. The cap is enforced via a
   * race-free read+count+check; concurrent grants race on the underlying
   * partial-unique index.
   */
  async approveGuardian(
    kindergartenId: string,
    primaryUserId: string,
    guardianId: string,
    grantApprovalRights = false,
  ): Promise<ChildGuardian> {
    const kgId = KindergartenId.parse(kindergartenId);
    const primary = UserId.parse(primaryUserId);

    const guardian = await this.guardians.findById(kindergartenId, guardianId);
    if (!guardian) throw new GuardianNotFoundError(guardianId);
    await this.assertCallerIsApprovedPrimary(
      kindergartenId,
      guardian.childId,
      primary,
    );

    if (grantApprovalRights) {
      // Serialize concurrent grants on the same child against the ≤2 cap.
      // The advisory lock is released at the ambient TX boundary; the
      // count below thus observes any prior in-flight grant's write.
      await this.guardians.acquireApprovalRightsLock(
        kindergartenId,
        guardian.childId,
      );
      const current = await this.guardians.countApprovalRights(
        kindergartenId,
        guardian.childId,
      );
      if (current >= 2) {
        throw new MaxApprovalRightsExceededError(guardian.childId);
      }
    }

    guardian.approve(primary, this.clock.now(), grantApprovalRights);
    await this.guardians.update(guardian);
    await this.notification.notifyGuardianApproved({
      kindergartenId: kgId,
      childId: guardian.childId,
      guardianUserId: guardian.userId,
      approvedBy: primaryUserId,
      hasApprovalRights: guardian.hasApprovalRights,
    });
    return guardian;
  }

  async rejectGuardian(
    kindergartenId: string,
    primaryUserId: string,
    guardianId: string,
  ): Promise<ChildGuardian> {
    const kgId = KindergartenId.parse(kindergartenId);
    const primary = UserId.parse(primaryUserId);
    const guardian = await this.guardians.findById(kindergartenId, guardianId);
    if (!guardian) throw new GuardianNotFoundError(guardianId);
    await this.assertCallerIsApprovedPrimary(
      kindergartenId,
      guardian.childId,
      primary,
    );
    guardian.reject(this.clock.now());
    await this.guardians.update(guardian);
    await this.notification.notifyGuardianRejected({
      kindergartenId: kgId,
      childId: guardian.childId,
      guardianUserId: guardian.userId,
      rejectedBy: primaryUserId,
    });
    return guardian;
  }

  async revokeGuardianByPrimary(
    kindergartenId: string,
    primaryUserId: string,
    guardianId: string,
  ): Promise<ChildGuardian> {
    const kgId = KindergartenId.parse(kindergartenId);
    const primary = UserId.parse(primaryUserId);
    const guardian = await this.guardians.findById(kindergartenId, guardianId);
    if (!guardian) throw new GuardianNotFoundError(guardianId);
    await this.assertCallerIsApprovedPrimary(
      kindergartenId,
      guardian.childId,
      primary,
    );
    if (guardian.userId === primary) {
      throw new PrimaryCannotSelfRevokeError(primary);
    }
    guardian.revoke(primary, this.clock.now());
    await this.guardians.update(guardian);
    await this.notification.notifyGuardianRevoked({
      kindergartenId: kgId,
      childId: guardian.childId,
      guardianUserId: guardian.userId,
      revokedBy: primaryUserId,
    });
    return guardian;
  }

  /**
   * Parent-side cross-tenant link by IIN. Called from
   * `POST /parent/children/link` — the caller has only their JWT-derived
   * user_id and no kindergarten context yet.
   *
   * Resolves the child via a cross-tenant IIN lookup, then opens its own
   * tenant-scoped TX (the route is not behind KindergartenScopeGuard, so the
   * ambient TenantContextInterceptor TX has no `app.kindergarten_id` set) and
   * inserts a `pending_approval` row for the calling user. The approved
   * primary, if any, gets a notification and decides via the regular
   * approve/reject flow.
   *
   * Errors:
   *   - per-user rate-limit exceeded → ParentLinkRateLimitError (429)
   *   - 0 candidates  → ChildNotFoundForIinError
   *   - >1 candidates → MultipleChildrenForIinError (no kindergartenIds in
   *     payload — exposing tenant membership to an authenticated probe is
   *     itself an information leak)
   *   - caller already has APPROVED row on the child → AlreadyLinkedToChildError
   *   - caller already has PENDING_APPROVAL row     → AlreadyPendingForChildError
   *   - caller has only a REVOKED row → fresh pending row is allowed (the
   *     partial-unique idx permits multiple revoked rows alongside one active)
   *
   * Rate-limit is applied BEFORE the IIN lookup so the cross-tenant probe
   * itself is gated. Default 5 attempts / hour per authenticated user
   * (`auth.rateLimitParentLinkLimit` / `auth.rateLimitParentLinkWindowSec`).
   *
   * TODO(refactor): split child.service.ts on parent vs admin paths — file
   * crossed ~880 lines after B6 (CLAUDE.md §8 threshold ~700). See
   * IMPLEMENTATION_PLAN.md §5 Active.
   */
  async linkChildByIin(
    callerUserId: string,
    input: LinkChildByIinInput,
  ): Promise<LinkChildByIinResult> {
    const callerId = UserId.parse(callerUserId);

    // Rate-limit per authenticated user — gates the cross-tenant IIN probe
    // itself, not just the success path. Without this, any caller with a
    // valid JWT could enumerate child existence platform-wide.
    const rlLimit = this.configService.getOrThrow(
      'auth.rateLimitParentLinkLimit',
      { infer: true },
    );
    const rlWindow = this.configService.getOrThrow(
      'auth.rateLimitParentLinkWindowSec',
      { infer: true },
    );
    const rlState = await this.otpStore.checkRateLimitGeneric(
      `rate:parent:link:${callerId}`,
      rlLimit,
      rlWindow,
    );
    if (rlState === 'exceeded') {
      throw new ParentLinkRateLimitError();
    }

    const candidates = await this.children.findByIinCrossTenant(input.iin);
    if (candidates.length === 0) {
      throw new ChildNotFoundForIinError(input.iin);
    }
    if (candidates.length > 1) {
      throw new MultipleChildrenForIinError(input.iin);
    }
    const child = candidates[0];
    const targetKgId = child.kindergartenId as string;

    return this.dataSource.transaction(async (manager) => {
      // SET LOCAL does not accept parameter binds; defend against non-UUID
      // tenant ids the same way TenantContextInterceptor does.
      if (!KG_UUID_RE.test(targetKgId)) {
        throw new Error(`invalid_kindergarten_id: ${targetKgId}`);
      }
      await manager.query(`SET LOCAL app.kindergarten_id = '${targetKgId}'`);
      return tenantStorage.run(
        { kgId: targetKgId, bypass: false, entityManager: manager },
        async () => {
          const existing = await this.guardians.findActiveByChildAndUser(
            targetKgId,
            child.id,
            callerId,
          );
          if (existing) {
            if (existing.status.equals(GuardianStatus.APPROVED)) {
              throw new AlreadyLinkedToChildError(child.id, callerId);
            }
            if (existing.status.equals(GuardianStatus.PENDING_APPROVAL)) {
              throw new AlreadyPendingForChildError(child.id, callerId);
            }
            // Other non-revoked statuses (rejected) – treat as conflict for
            // hygiene; the partial-unique idx in DB also blocks two pendings.
            throw new AlreadyPendingForChildError(child.id, callerId);
          }

          const role = GuardianRelation.fromString(input.role);
          const guardian = ChildGuardian.createPending({
            id: randomUUID(),
            kindergartenId: KindergartenId.parse(targetKgId),
            childId: ChildId.parse(child.id),
            userId: callerId,
            role,
            canPickup: input.canPickup ?? false,
            now: this.clock.now(),
          });
          await this.guardians.create(guardian);

          // Find approved primary on this child for notification fan-out.
          const allGuardians = await this.guardians.findByChildId(
            targetKgId,
            child.id,
          );
          const primary = allGuardians.find(
            (g) =>
              g.role.equals(GuardianRelation.PRIMARY) &&
              g.status.equals(GuardianStatus.APPROVED),
          );
          if (primary) {
            await this.notification.notifyGuardianPendingApproval({
              kindergartenId: targetKgId,
              childId: child.id,
              childFullName: child.fullName,
              primaryUserId: primary.userId,
              requesterUserId: callerId,
              role: input.role,
            });
          }
          return { guardian, child };
        },
      );
    });
  }

  /**
   * Parent self-unlink: a SECONDARY/NANNY guardian drops their own approved
   * row. Called from `POST /parent/children/:id/unlink`. The route is behind
   * ChildAccessGuard, which already 403s callers without an approved guardian
   * record — but we re-check here defensively.
   *
   * Domain error fan-out:
   *   - role=primary  → PrimaryCannotSelfUnlinkError (403)
   *   - non-approved  → ChildAccessDeniedError (403; defensive — the guard
   *     should have caught this already)
   */
  async selfUnlinkFromChild(
    kindergartenId: string,
    callerUserId: string,
    childId: string,
  ): Promise<void> {
    const guardian = await this.guardians.findActiveByChildAndUser(
      kindergartenId,
      childId,
      callerUserId,
    );
    if (!guardian || !guardian.status.equals(GuardianStatus.APPROVED)) {
      throw new ChildAccessDeniedError(callerUserId, childId);
    }
    const revokedAt = this.clock.now();
    guardian.revokeBySelf(revokedAt);
    await this.guardians.update(guardian);
    await this.notification.notifyGuardianSelfRevoked({
      kindergartenId,
      childId,
      userId: callerUserId,
      revokedAt,
    });
  }

  async toggleGuardianApprovalRights(
    kindergartenId: string,
    primaryUserId: string,
    guardianId: string,
    grant: boolean,
  ): Promise<ChildGuardian> {
    const primary = UserId.parse(primaryUserId);
    const guardian = await this.guardians.findById(kindergartenId, guardianId);
    if (!guardian) throw new GuardianNotFoundError(guardianId);
    await this.assertCallerIsApprovedPrimary(
      kindergartenId,
      guardian.childId,
      primary,
    );
    if (grant && !guardian.hasApprovalRights) {
      // Same advisory-lock guard as approveGuardian — the cap is checked
      // again here because toggle is the second admin entry-point onto
      // the same invariant.
      await this.guardians.acquireApprovalRightsLock(
        kindergartenId,
        guardian.childId,
      );
      const current = await this.guardians.countApprovalRights(
        kindergartenId,
        guardian.childId,
      );
      if (current >= 2) {
        throw new MaxApprovalRightsExceededError(guardian.childId);
      }
    }
    guardian.toggleApprovalRights(grant, this.clock.now());
    await this.guardians.update(guardian);
    return guardian;
  }

  /**
   * Parent (approved primary) patches a guardian's permissions. Locked-key
   * rejection and unknown-key rejection live in `GuardianPermissions` —
   * service only enforces authorization and persistence.
   *
   * NOTE: the OTP-gated variant from the legacy repo is intentionally deferred
   * to a later phase. For P5 the patch is admitted directly given the caller
   * already passed ChildAccessGuard + the in-service primary check.
   */
  async updateGuardianPermissions(
    kindergartenId: string,
    primaryUserId: string,
    guardianId: string,
    permissions: Record<string, boolean>,
  ): Promise<{ guardian: ChildGuardian; effective: Record<string, boolean> }> {
    const kgId = KindergartenId.parse(kindergartenId);
    const primary = UserId.parse(primaryUserId);
    const patchVo = GuardianPermissions.fromObject(permissions);
    const guardian = await this.guardians.findById(kindergartenId, guardianId);
    if (!guardian) throw new GuardianNotFoundError(guardianId);
    await this.assertCallerIsApprovedPrimary(
      kindergartenId,
      guardian.childId,
      primary,
    );
    guardian.applyPermissionsPatch(patchVo, primary, this.clock.now());
    await this.guardians.update(guardian);
    const effective = guardian.permissions.effective(guardian.role);
    await this.notification.notifyPermissionsUpdated({
      kindergartenId: kgId,
      childId: guardian.childId,
      guardianUserId: guardian.userId,
      updatedBy: primaryUserId,
      effectivePermissions: effective,
    });
    return { guardian, effective };
  }

  async resetGuardianPermissions(
    kindergartenId: string,
    primaryUserId: string,
    guardianId: string,
  ): Promise<{ guardian: ChildGuardian; effective: Record<string, boolean> }> {
    const kgId = KindergartenId.parse(kindergartenId);
    const primary = UserId.parse(primaryUserId);
    const guardian = await this.guardians.findById(kindergartenId, guardianId);
    if (!guardian) throw new GuardianNotFoundError(guardianId);
    await this.assertCallerIsApprovedPrimary(
      kindergartenId,
      guardian.childId,
      primary,
    );
    guardian.resetPermissions(primary, this.clock.now());
    await this.guardians.update(guardian);
    const effective = guardian.permissions.effective(guardian.role);
    await this.notification.notifyPermissionsUpdated({
      kindergartenId: kgId,
      childId: guardian.childId,
      guardianUserId: guardian.userId,
      updatedBy: primaryUserId,
      effectivePermissions: effective,
    });
    return { guardian, effective };
  }

  listPendingApprovalsForPrimary(
    kindergartenId: string,
    primaryUserId: string,
  ): Promise<ChildGuardian[]> {
    return this.guardians.findPendingForPrimary(kindergartenId, primaryUserId);
  }

  /**
   * List children where the caller is an APPROVED guardian (any role). Used by
   * the parent-side homepage.
   */
  async listMyChildren(
    kindergartenId: string,
    userId: string,
  ): Promise<Child[]> {
    const guardians = await this.guardians.findApprovedByUser(
      kindergartenId,
      userId,
    );
    const out: Child[] = [];
    for (const g of guardians) {
      const child = await this.children.findById(kindergartenId, g.childId);
      if (child) out.push(child);
    }
    return out;
  }

  /**
   * Cross-tenant variant for parents whose JWT has no `kindergarten_id`
   * (multi-kg pending-role-select state, or freshly-linked parents who have
   * not yet rotated their token after primary-approval). Both repository
   * lookups bypass RLS via `app.bypass_rls=true` inside their own
   * transactions; scope leakage is bounded by the user's own approved
   * guardian rows + their child ids — no other tenant data is observable.
   * The single-kg path (`listMyChildren`) remains the default since RLS is
   * still enforced there.
   */
  async listMyChildrenCrossTenant(userId: string): Promise<Child[]> {
    const guardians =
      await this.guardians.findApprovedActiveByUserIdCrossTenant(userId);
    if (guardians.length === 0) return [];
    const childIds = Array.from(new Set(guardians.map((g) => g.childId)));
    return this.children.findByIdsCrossTenant(childIds);
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  /**
   * Throws NotPrimaryGuardianError unless the caller is an APPROVED PRIMARY
   * guardian on the same child. Used by every parent-side mutation as
   * defense-in-depth around ChildAccessGuard.
   */
  private async assertCallerIsApprovedPrimary(
    kindergartenId: string,
    childId: string,
    primaryUserId: string,
  ): Promise<void> {
    const caller = await this.guardians.findActiveByChildAndUser(
      kindergartenId,
      childId,
      primaryUserId,
    );
    if (
      !caller ||
      !caller.role.equals(GuardianRelation.PRIMARY) ||
      !caller.status.equals(GuardianStatus.APPROVED)
    ) {
      throw new NotPrimaryGuardianError(primaryUserId, childId);
    }
  }

  // ── small staff helper exposed for controllers ──────────────────────────

  async resolveStaffMemberIdForUser(
    kindergartenId: string,
    userId: string,
  ): Promise<string> {
    const me = await this.staff.findActiveByUserAndKindergarten(
      userId,
      kindergartenId,
    );
    if (!me) throw new StaffNotFoundError(userId);
    return me.id;
  }
}
