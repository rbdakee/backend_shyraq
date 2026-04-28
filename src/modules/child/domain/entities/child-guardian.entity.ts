import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { GuardianPermissions } from '@/shared-kernel/domain/value-objects/guardian-permissions.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { GuardianStatus } from '@/shared-kernel/domain/value-objects/guardian-status.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { UserId } from '@/shared-kernel/domain/value-objects/user-id.vo';
import { GuardianNotApprovedError } from '../errors/guardian-not-approved.error';
import { InvalidGuardianStatusTransitionError } from '../errors/invalid-guardian-status-transition.error';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChildGuardianState {
  id: string;
  kindergartenId: string;
  childId: string;
  userId: string;
  role: 'primary' | 'secondary' | 'nanny';
  status: 'pending_approval' | 'approved' | 'rejected' | 'revoked';
  hasApprovalRights: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  revokedBy: string | null;
  revokedAt: Date | null;
  canPickup: boolean;
  permissions: Record<string, boolean>;
  permissionsUpdatedBy: string | null;
  permissionsUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePendingGuardianInput {
  id: string;
  kindergartenId: KindergartenId;
  childId: ChildId;
  userId: UserId;
  role: GuardianRelation;
  canPickup?: boolean;
  now: Date;
}

export interface UpdateGuardianRoleAndPickupPatch {
  role?: GuardianRelation;
  canPickup?: boolean;
}

function assertUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(`${label} must be UUID, got: ${value}`);
  }
}

/**
 * ChildGuardian aggregate. State machine:
 *
 *     created → pending_approval ──approve──▶ approved ──revoke──▶ revoked
 *                          │                       │
 *                          └──reject──▶ rejected   └──reset/permissions
 *                          │
 *                          └──admin revoke──▶ revoked
 *
 * Terminal states: rejected, revoked. Role/pickup updates are allowed in
 * non-terminal states. Permissions/approval-rights operations require
 * status=approved. The 2-approver cap per child is enforced in the service
 * layer (race-free read+check); this entity only flips the flag when allowed.
 */
export class ChildGuardian {
  id: string;
  kindergartenId: KindergartenId;
  childId: ChildId;
  userId: UserId;
  role: GuardianRelation;
  status: GuardianStatus;
  hasApprovalRights: boolean;
  approvedBy: UserId | undefined;
  approvedAt: Date | undefined;
  revokedBy: UserId | undefined;
  revokedAt: Date | undefined;
  canPickup: boolean;
  permissions: GuardianPermissions;
  permissionsUpdatedBy: UserId | undefined;
  permissionsUpdatedAt: Date | undefined;
  createdAt: Date;
  updatedAt: Date;

  private constructor(props: {
    id: string;
    kindergartenId: KindergartenId;
    childId: ChildId;
    userId: UserId;
    role: GuardianRelation;
    status: GuardianStatus;
    hasApprovalRights: boolean;
    approvedBy: UserId | undefined;
    approvedAt: Date | undefined;
    revokedBy: UserId | undefined;
    revokedAt: Date | undefined;
    canPickup: boolean;
    permissions: GuardianPermissions;
    permissionsUpdatedBy: UserId | undefined;
    permissionsUpdatedAt: Date | undefined;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = props.id;
    this.kindergartenId = props.kindergartenId;
    this.childId = props.childId;
    this.userId = props.userId;
    this.role = props.role;
    this.status = props.status;
    this.hasApprovalRights = props.hasApprovalRights;
    this.approvedBy = props.approvedBy;
    this.approvedAt = props.approvedAt;
    this.revokedBy = props.revokedBy;
    this.revokedAt = props.revokedAt;
    this.canPickup = props.canPickup;
    this.permissions = props.permissions;
    this.permissionsUpdatedBy = props.permissionsUpdatedBy;
    this.permissionsUpdatedAt = props.permissionsUpdatedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static createPending(input: CreatePendingGuardianInput): ChildGuardian {
    assertUuid(input.id, 'guardian.id');
    return new ChildGuardian({
      id: input.id,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      userId: input.userId,
      role: input.role,
      status: GuardianStatus.PENDING_APPROVAL,
      hasApprovalRights: false,
      approvedBy: undefined,
      approvedAt: undefined,
      revokedBy: undefined,
      revokedAt: undefined,
      canPickup: input.canPickup ?? true,
      permissions: GuardianPermissions.empty(),
      permissionsUpdatedBy: undefined,
      permissionsUpdatedAt: undefined,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static hydrate(state: ChildGuardianState): ChildGuardian {
    return new ChildGuardian({
      id: state.id,
      kindergartenId: KindergartenId.parse(state.kindergartenId),
      childId: ChildId.parse(state.childId),
      userId: UserId.parse(state.userId),
      role: GuardianRelation.fromString(state.role),
      status: GuardianStatus.fromString(state.status),
      hasApprovalRights: state.hasApprovalRights,
      approvedBy:
        state.approvedBy === null ? undefined : UserId.parse(state.approvedBy),
      approvedAt: state.approvedAt ?? undefined,
      revokedBy:
        state.revokedBy === null ? undefined : UserId.parse(state.revokedBy),
      revokedAt: state.revokedAt ?? undefined,
      canPickup: state.canPickup,
      permissions: GuardianPermissions.fromObject(state.permissions),
      permissionsUpdatedBy:
        state.permissionsUpdatedBy === null
          ? undefined
          : UserId.parse(state.permissionsUpdatedBy),
      permissionsUpdatedAt: state.permissionsUpdatedAt ?? undefined,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }

  approve(by: UserId, now: Date, grantApprovalRights = false): void {
    if (!this.status.equals(GuardianStatus.PENDING_APPROVAL)) {
      throw new InvalidGuardianStatusTransitionError(
        this.status.value,
        'approved',
      );
    }
    this.status = GuardianStatus.APPROVED;
    this.approvedAt = now;
    this.approvedBy = by;
    if (grantApprovalRights) {
      this.hasApprovalRights = true;
    }
    this.updatedAt = now;
  }

  reject(now: Date): void {
    if (!this.status.equals(GuardianStatus.PENDING_APPROVAL)) {
      throw new InvalidGuardianStatusTransitionError(
        this.status.value,
        'rejected',
      );
    }
    this.status = GuardianStatus.REJECTED;
    this.updatedAt = now;
  }

  /**
   * Revoke from either pending_approval or approved. Admin-side and
   * primary-side both call this — the caller decides what `by` means.
   */
  revoke(by: UserId, now: Date): void {
    if (
      !this.status.equals(GuardianStatus.PENDING_APPROVAL) &&
      !this.status.equals(GuardianStatus.APPROVED)
    ) {
      throw new InvalidGuardianStatusTransitionError(
        this.status.value,
        'revoked',
      );
    }
    this.status = GuardianStatus.REVOKED;
    this.revokedAt = now;
    this.revokedBy = by;
    this.updatedAt = now;
  }

  /**
   * Admin-side patch. Disallowed on revoked (record is terminal). Role change
   * does NOT reset permissions — explicit admin contract.
   */
  updateRoleAndPickup(
    patch: UpdateGuardianRoleAndPickupPatch,
    now: Date,
  ): void {
    if (this.status.equals(GuardianStatus.REVOKED)) {
      throw new InvalidGuardianStatusTransitionError(
        this.status.value,
        'role_or_pickup_update',
      );
    }
    if (patch.role !== undefined) {
      this.role = patch.role;
    }
    if (patch.canPickup !== undefined) {
      this.canPickup = patch.canPickup;
    }
    this.updatedAt = now;
  }

  /**
   * Patch toggleable permissions. Locked-key rejection happens inside
   * `GuardianPermissions.merge` — this method only enforces status=approved.
   */
  applyPermissionsPatch(
    patch: GuardianPermissions,
    by: UserId,
    now: Date,
  ): void {
    if (!this.status.equals(GuardianStatus.APPROVED)) {
      throw new GuardianNotApprovedError(this.id, this.status.value);
    }
    this.permissions = this.permissions.merge(patch);
    this.permissionsUpdatedAt = now;
    this.permissionsUpdatedBy = by;
    this.updatedAt = now;
  }

  resetPermissions(by: UserId, now: Date): void {
    if (!this.status.equals(GuardianStatus.APPROVED)) {
      throw new GuardianNotApprovedError(this.id, this.status.value);
    }
    this.permissions = GuardianPermissions.empty();
    this.permissionsUpdatedAt = now;
    this.permissionsUpdatedBy = by;
    this.updatedAt = now;
  }

  /**
   * Cap of ≤2 per child is enforced in the service layer (race-free read+check)
   * and by a DB trigger — not here. This method only flips the flag when
   * allowed.
   */
  toggleApprovalRights(grant: boolean, now: Date): void {
    if (!this.status.equals(GuardianStatus.APPROVED)) {
      throw new GuardianNotApprovedError(this.id, this.status.value);
    }
    this.hasApprovalRights = grant;
    this.updatedAt = now;
  }

  toState(): ChildGuardianState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this.childId,
      userId: this.userId,
      role: this.role.value,
      status: this.status.value,
      hasApprovalRights: this.hasApprovalRights,
      approvedBy: this.approvedBy ?? null,
      approvedAt: this.approvedAt ?? null,
      revokedBy: this.revokedBy ?? null,
      revokedAt: this.revokedAt ?? null,
      canPickup: this.canPickup,
      permissions: this.permissions.toJSON(),
      permissionsUpdatedBy: this.permissionsUpdatedBy ?? null,
      permissionsUpdatedAt: this.permissionsUpdatedAt ?? null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
