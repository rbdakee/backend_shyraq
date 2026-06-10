import {
  LOCKED_PERMISSION_KEYS,
  PermissionKey,
} from '@/shared-kernel/domain/value-objects/guardian-permissions.vo';
import { ChildGroupHistoryRecord } from './infrastructure/persistence/child.repository';
import { PendingApplicantRequestView } from './infrastructure/persistence/child-guardian.repository';
import { PendingApplicantRequestDto } from './dto/pending-applicant-request.dto';
import { Child } from './domain/entities/child.entity';
import { ChildGuardian } from './domain/entities/child-guardian.entity';
import { ChildStatusHistory } from './domain/entities/child-status-history.entity';
import {
  ChildDto,
  ChildGroupHistoryDto,
  ChildStatusHistoryDto,
  EffectivePermissionsDto,
  GuardianDto,
} from './dto';

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Mask a person's name for the applicant-facing pending-requests view: split
 * on whitespace, and reduce each word to its FIRST character + `****`.
 *
 *   "Алия Бекова" → "А**** Б****"
 *   "Алия"        → "А****"
 *   ""            → ""        (empty / whitespace-only stays empty)
 *
 * Pure function — exported so it can be unit-tested in isolation. Used to keep
 * child PII hidden until the primary guardian approves the link (same gating
 * as the `/link` endpoint, which never echoes child data).
 */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => `${[...word][0]}****`)
    .join(' ');
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

  /**
   * Maps a guardian aggregate → response DTO. The optional `identity` overlay
   * carries display fields (`full_name` / `phone`) resolved from the linked
   * `users` row — `child_guardians` stores only `user_id`, so without it the
   * admin/parent guardian views would surface a bare UUID. Mirrors the
   * staff-list identity overlay (`StaffPresenter.staff`). Absent overlay →
   * both fields fall back to null.
   */
  static guardian(
    g: ChildGuardian,
    identity?: { fullName: string | null; phone: string | null },
  ): GuardianDto {
    const state = g.toState();
    return {
      id: state.id,
      kindergarten_id: state.kindergartenId,
      child_id: state.childId,
      user_id: state.userId,
      user_full_name: identity?.fullName ?? null,
      user_phone: identity?.phone ?? null,
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

  /** B22a T9 — present a single `child_status_history` row (admin audit). */
  static statusHistory(h: ChildStatusHistory): ChildStatusHistoryDto {
    return {
      id: h.id,
      previous_status: h.previousStatus,
      new_status: h.newStatus,
      previous_archive_reason: h.previousArchiveReason,
      archive_reason: h.archiveReason,
      changed_by_user_id: h.changedByUserId,
      changed_at: h.changedAt.toISOString(),
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

  /**
   * APPLICANT-perspective pending link request → snake_case response DTO.
   * Child PII is masked (`maskName`) — only the first letter of each name word
   * is exposed, never the full name / IIN / dob / photo. `status` is always
   * `pending_approval` for this endpoint.
   */
  static pendingApplicantRequest(
    v: PendingApplicantRequestView,
  ): PendingApplicantRequestDto {
    return {
      id: v.id,
      role: v.role,
      can_pickup: v.canPickup,
      status: 'pending_approval',
      child_name_masked: maskName(v.childName),
      kindergarten: { name: v.kindergartenName },
      created_at: v.createdAt.toISOString(),
    };
  }
}
