import {
  LOCKED_PERMISSION_KEYS,
  PermissionKey,
} from '@/shared-kernel/domain/value-objects/guardian-permissions.vo';
import { ChildGroupHistoryRecord } from './infrastructure/persistence/child.repository';
import { Child } from './domain/entities/child.entity';
import { ChildGuardian } from './domain/entities/child-guardian.entity';
import {
  ChildDto,
  ChildGroupHistoryDto,
  EffectivePermissionsDto,
  GuardianDto,
} from './dto';

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class ChildPresenter {
  static child(c: Child): ChildDto {
    const state = c.toState();
    return {
      id: state.id,
      kindergarten_id: state.kindergartenId,
      iin: state.iin,
      full_name: state.fullName,
      date_of_birth: toIsoDate(state.dateOfBirth),
      gender:
        state.gender === 'm' ? 'male' : state.gender === 'f' ? 'female' : null,
      photo_url: state.photoUrl,
      status: state.status,
      current_group_id: state.currentGroupId,
      enrollment_date:
        state.enrollmentDate === null ? null : toIsoDate(state.enrollmentDate),
      archived_at:
        state.archivedAt === null ? null : state.archivedAt.toISOString(),
      archive_reason: state.archiveReason,
      medical_notes: state.medicalNotes,
      allergy_notes: state.allergyNotes,
      created_at: state.createdAt.toISOString(),
      updated_at: state.updatedAt.toISOString(),
    };
  }

  static guardian(g: ChildGuardian): GuardianDto {
    const state = g.toState();
    return {
      id: state.id,
      kindergarten_id: state.kindergartenId,
      child_id: state.childId,
      user_id: state.userId,
      role: state.role,
      status: state.status,
      has_approval_rights: state.hasApprovalRights,
      can_pickup: state.canPickup,
      permissions: state.permissions,
      approved_by: state.approvedBy,
      approved_at:
        state.approvedAt === null ? null : state.approvedAt.toISOString(),
      revoked_by: state.revokedBy,
      revoked_at:
        state.revokedAt === null ? null : state.revokedAt.toISOString(),
      permissions_updated_by: state.permissionsUpdatedBy,
      permissions_updated_at:
        state.permissionsUpdatedAt === null
          ? null
          : state.permissionsUpdatedAt.toISOString(),
      created_at: state.createdAt.toISOString(),
      updated_at: state.updatedAt.toISOString(),
    };
  }

  static groupHistory(r: ChildGroupHistoryRecord): ChildGroupHistoryDto {
    return {
      id: r.id,
      child_id: r.childId,
      from_group_id: r.fromGroupId,
      to_group_id: r.toGroupId,
      transferred_at: r.transferredAt.toISOString(),
      transferred_by_staff_id: r.transferredByStaffId,
      reason: r.reason,
    };
  }

  static effectivePermissions(g: ChildGuardian): EffectivePermissionsDto {
    return {
      role: g.role.value,
      effective: g.permissions.effective(g.role) as Record<
        PermissionKey,
        boolean
      >,
      overrides: g.permissions.overridesAgainst(g.role),
      can_pickup: g.canPickup,
      has_approval_rights: g.hasApprovalRights,
    };
  }

  static lockedKeys(): readonly string[] {
    return LOCKED_PERMISSION_KEYS;
  }
}
