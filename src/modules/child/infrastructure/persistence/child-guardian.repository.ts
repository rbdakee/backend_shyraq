import { ChildGuardian } from '../../domain/entities/child-guardian.entity';

/**
 * Read-projection over a single pending `child_guardians` row from the
 * APPLICANT's perspective (the caller's own `link` request awaiting approval).
 *
 * Carries the child + kindergarten NAMES that the `ChildGuardian` domain
 * aggregate does not hold — populated by the relational repo via a JOIN
 * through `children` and `kindergartens`. The applicant-facing presenter masks
 * `childName` before it reaches the HTTP response (PII is hidden until the
 * primary guardian approves the link).
 */
export interface PendingApplicantRequestView {
  id: string;
  role: string;
  canPickup: boolean;
  childName: string;
  kindergartenName: string;
  createdAt: Date;
}

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

  /**
   * Cross-tenant variant of {@link findPendingForPrimary}: pending_approval
   * guardian rows on children where the caller is an approved primary, across
   * EVERY kindergarten (no kg filter). Used by the parent-side
   * `/parent/approvals/pending` endpoint when the JWT carries no
   * `kindergarten_id` (multi-kg parent). Bypasses RLS via `app.bypass_rls=true`
   * inside its own transaction; the `child_id IN (… caller is approved primary
   * …)` subquery bounds the result to the caller's own children, so the
   * cross-tenant read never exposes another parent's pending rows.
   *
   * Default no-op so older in-memory fakes compile; relational impl overrides.
   */
  findPendingForPrimaryCrossTenant(
    _primaryUserId: string,
  ): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }

  abstract update(guardian: ChildGuardian): Promise<void>;

  /**
   * Conditional UPDATE used by status transitions (approve / reject / revoke).
   * Writes ALL fields (same as `update`) BUT the WHERE clause additionally
   * requires `status = :expectedStatus`. Returns true if exactly one row was
   * affected, false if status changed between the service's read and write
   * (concurrent transition lost the race). Callers map false → throw
   * `ChildGuardianStatusConflictError` for a 409 response.
   *
   * Closes FINDINGS.md SM2 — previously the plain `update` overwrote
   * concurrent transitions silently (last writer wins).
   *
   * Default no-op fallback returns true so older test fakes keep compiling;
   * the relational impl provides the real conditional UPDATE.
   */
  updateWithExpectedStatus(
    guardian: ChildGuardian,
    _expectedStatus: string,
  ): Promise<boolean> {
    return this.update(guardian).then(() => true);
  }

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

  // ── B16 — non-abstract defaults so older test fakes keep compiling.
  //   The relational impl overrides each method.

  /**
   * B16 — Counts the number of OTHER non-archived children in this kg
   * that share at least one approved-active guardian (parent) with the
   * given child. Used by `InvoiceService` to populate the
   * `familyContext.siblingsInKgCount` for the discount engine's
   * sibling-rule + custom-discount conditions.
   *
   * Excludes the child itself from the count. Counts distinct sibling
   * children, not pairs — a sibling shared via two parents still counts
   * as 1.
   */
  countSiblingsInKgForChild(
    _kindergartenId: string,
    _childId: string,
  ): Promise<number> {
    return Promise.resolve(0);
  }

  /**
   * B16 — fans out `targetChildIds` (from a `discount.activated` event)
   * into the distinct set of approved-active guardian user_ids across
   * all those children. Used by the dispatcher's recipient resolver so
   * a single multi-child query replaces N per-child fan-out queries.
   *
   * Excludes nanny-role guardians (B16 BP §4.1: discount notifications
   * are parent-only). Empty input returns `[]` without a query.
   */
  findApprovedUserIdsBySomeChildIds(
    _kindergartenId: string,
    _childIds: string[],
  ): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ── B17 — Content & Stories recipient resolvers ──────────────────────
  // Non-abstract default-no-op so older test fakes compile. The relational
  // impl overrides with real SQL JOINs through children.

  /**
   * B17 — distinct approved-active guardian user_ids for every
   * non-archived child whose `current_group_id = groupId`. Used by the
   * dispatcher resolvers for `content.news_published` (target_type='group')
   * and `content.story_new`. Excludes nanny-role guardians.
   */
  findApprovedUserIdsByGroup(
    _kindergartenId: string,
    _groupId: string,
  ): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * B17 — distinct approved-active guardian user_ids across every
   * non-archived child in the kindergarten. Used by the dispatcher
   * resolvers for `content.news_published` (target_type='all') and
   * `content.qundylyq_new`. Excludes nanny-role guardians.
   */
  findApprovedUserIdsByKindergarten(
    _kindergartenId: string,
  ): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * APPLICANT-perspective lookup of the caller's OWN pending link requests.
   * Returns every `child_guardians` row where `user_id = userId AND
   * status = 'pending_approval'`, CROSS-TENANT (a parent may have requests in
   * several kindergartens). Bypasses RLS via `app.bypass_rls=true` inside its
   * own transaction — mirrors `findPendingPrimaryByUserIdCrossTenant` /
   * `findApprovedActiveByUserIdCrossTenant`. The caller is responsible for
   * masking child PII before exposing the result (the data belongs to the
   * caller's own requests, so cross-tenant exposure is bounded to their rows).
   *
   * Non-abstract default-no-op so older test fakes keep compiling; the
   * relational impl overrides with the real JOIN through `children` +
   * `kindergartens` to populate `childName` + `kindergartenName`.
   */
  findPendingByApplicantUserId(
    _userId: string,
  ): Promise<PendingApplicantRequestView[]> {
    return Promise.resolve([]);
  }
}
