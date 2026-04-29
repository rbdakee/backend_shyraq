import { ChildGuardian } from '../../domain/entities/child-guardian.entity';

/**
 * Port over the `child_guardians` table.
 *
 * Cross-tenant lookups (used by ChildAccessGuard / RoleAssembler) deliberately
 * bypass RLS via the bypass_rls GUC — service code that calls these is
 * responsible for re-checking tenant scope before exposing data to the user.
 */
export abstract class ChildGuardianRepository {
  abstract create(guardian: ChildGuardian): Promise<void>;
  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<ChildGuardian | null>;
  abstract findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGuardian[]>;
  /**
   * Used to enforce the (child_id, user_id) unique constraint in-app before
   * INSERT — clearer error than catching 23505. Returns any non-revoked row.
   */
  abstract findActiveByChildAndUser(
    kindergartenId: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null>;

  /**
   * Cross-tenant variant of findActiveByChildAndUser. ChildAccessGuard uses it
   * to decide whether the calling user is an approved guardian of the
   * requested child without already knowing the kg context.
   */
  abstract findApprovedByChildAndUserCrossTenant(
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null>;

  /** Cross-tenant by guardian id only — fallback path for parent-side endpoints. */
  abstract findByIdCrossTenant(
    guardianId: string,
  ): Promise<ChildGuardian | null>;

  abstract findPendingForPrimary(
    kindergartenId: string,
    primaryUserId: string,
  ): Promise<ChildGuardian[]>;

  abstract update(guardian: ChildGuardian): Promise<void>;

  abstract countApprovalRights(
    kindergartenId: string,
    childId: string,
  ): Promise<number>;

  /**
   * Used by AuthModule role-assembly to enumerate the set of kg-ids on which
   * the user has at least one approved guardian record.
   */
  abstract listApprovedKindergartenIdsByUserId(
    userId: string,
  ): Promise<string[]>;

  /**
   * Used by parent-side listMyChildren — returns approved-guardian rows for the
   * given user across the (already kg-scoped) tenant.
   */
  abstract findApprovedByUser(
    kindergartenId: string,
    userId: string,
  ): Promise<ChildGuardian[]>;
}
