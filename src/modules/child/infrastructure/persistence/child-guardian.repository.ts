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
   * Acquire a per-(kg, child) advisory lock to serialize concurrent grants of
   * `has_approval_rights = true` against the ≤2 cap. Released automatically at
   * the surrounding TX boundary. Callers must invoke this BEFORE
   * `countApprovalRights` so the count reflects any in-flight writes by a
   * prior winner. Outside an ambient TX the lock effectively no-ops (released
   * at the implicit per-statement TX) — safe for non-HTTP code paths.
   */
  abstract acquireApprovalRightsLock(
    kindergartenId: string,
    childId: string,
  ): Promise<void>;

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

  /**
   * Cross-tenant lookup of pending primary-guardian rows for a given user.
   * Used by the auth pipeline (`verifyOtp` auto-approve hook) to flip
   * primary rows pre-seeded by the enrollment flow into `approved` once the
   * matching parent verifies their phone. Bypasses RLS via
   * `app.bypass_rls=true` inside its own transaction.
   */
  abstract findPendingPrimaryByUserIdCrossTenant(
    userId: string,
  ): Promise<ChildGuardian[]>;

  /**
   * Used by the B8 check-out flow to validate the picking-up parent. Returns
   * a guardian row only when ALL of these hold:
   *   - kindergarten_id = kg AND child_id = childId AND user_id = userId
   *   - status = 'approved'
   *   - revoked_at IS NULL
   *   - can_pickup = true
   *
   * Any failure → returns null (no leak about which condition failed; the
   * service collapses everything into PickupUserNotAllowedError).
   */
  abstract findApprovedActivePickupGuardian(
    kindergartenId: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null>;

  /**
   * Cross-tenant lookup of every approved + non-revoked guardian-child link
   * for `userId`. Used by the WS auto-subscribe handler to enumerate the
   * `child:{cid}` rooms a freshly-connected socket should join, regardless
   * of how many kindergartens that user has children in. Bypasses RLS via
   * `app.bypass_rls=true` inside its own transaction.
   *
   * When `kindergartenId` is provided, the result is filtered to that
   * single kg — used by the WS auto-subscribe handler to scope rooms to
   * the JWT's `kindergarten_id` claim (a parent who is also a guardian
   * in another kg must NOT receive that other kg's child events while
   * connected with a kgA-scoped JWT). The bypass is still required
   * because the runtime app role is NOBYPASSRLS and the GUC is not set
   * outside the HTTP pipeline (the WS handshake runs without it).
   */
  abstract findApprovedActiveByUserIdCrossTenant(
    userId: string,
    kindergartenId?: string,
  ): Promise<ChildGuardian[]>;

  /**
   * kg-scoped lookup for the current approved-active guardian link of a
   * user on a child. Differs from `findApprovedActivePickupGuardian` in
   * that it does NOT require `can_pickup = true` — used by callers that
   * just need to assert "is this user currently a guardian of this child?"
   * regardless of pickup-rights (e.g. trusted-people CRUD authorization,
   * pickup-flow notification recipient re-validation).
   *
   * Returns the guardian row only when ALL hold:
   *   - kindergarten_id = kg AND child_id = childId AND user_id = userId
   *   - status = 'approved'
   *   - revoked_at IS NULL
   *
   * No info-leak about which condition failed — returns null otherwise.
   */
  abstract findApprovedActiveByUserAndChild(
    kindergartenId: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null>;
}
