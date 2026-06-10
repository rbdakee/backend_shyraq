import { Child } from '../../domain/entities/child.entity';

export type ChildStatusFilter = 'card_created' | 'active' | 'archived';

/**
 * Result of a conditional state transition (`archive` / `reactivate`).
 * Discriminated union so the service can map a 0-row UPDATE to the right
 * error without a follow-up SELECT in the happy path:
 *   - `'archived'` / `'reactivated'`  → mutation committed, `child` is the
 *     post-mutation hydrate.
 *   - `'already-archived'` (for archive) / `'not-archived'` (for reactivate)
 *     → row exists but status guard failed → service throws 409.
 *   - `'not-found'`                   → row not in this kg → service throws 404.
 *
 * The relational impl runs a conditional UPDATE first; on 0 rows it
 * disambiguates with a single follow-up SELECT, so the common (happy) path
 * is still one round-trip.
 */
export type ChildArchiveResult =
  | { kind: 'archived'; child: Child }
  | { kind: 'already-archived' }
  | { kind: 'not-found' };

export type ChildReactivateResult =
  | { kind: 'reactivated'; child: Child }
  | { kind: 'not-archived' }
  | { kind: 'not-found' };

/**
 * Result of the `card_created → active` conditional transition. Same
 * discriminated-union shape as `archive`/`reactivate`:
 *   - `'activated'`        → mutation committed, `child` is the post-mutation hydrate.
 *   - `'not-card-created'` → row exists but status differs → service throws 422.
 *   - `'not-found'`        → row not in this kg → service throws 404.
 */
export type ChildActivateResult =
  | { kind: 'activated'; child: Child }
  | { kind: 'not-card-created' }
  | { kind: 'not-found' };

export interface ChildListFilters {
  status?: ChildStatusFilter;
  currentGroupId?: string;
  /** Substring match against full_name OR iin (case-insensitive on full_name). */
  q?: string;
}

export interface PageRequest {
  limit: number;
  offset: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
}

export interface ChildGroupHistoryRecord {
  id: string;
  childId: string;
  fromGroupId: string | null;
  toGroupId: string | null;
  transferredAt: Date;
  transferredByStaffId: string;
  reason: string | null;
}

/**
 * Port over the `children` table and its `child_group_history` audit. The
 * service layer always passes `kindergartenId` explicitly — RLS is
 * defense-in-depth, not the contract boundary.
 */
export abstract class ChildRepository {
  abstract create(child: Child): Promise<void>;
  abstract findById(kindergartenId: string, id: string): Promise<Child | null>;
  abstract findByKindergartenAndIin(
    kindergartenId: string,
    iin: string,
  ): Promise<Child | null>;
  abstract update(child: Child): Promise<void>;
  abstract list(
    kindergartenId: string,
    filters: ChildListFilters,
    page: PageRequest,
  ): Promise<PageResult<Child>>;

  /** Used by Group module to count active children per group (capacity guard). */
  abstract countActiveByGroup(
    kindergartenId: string,
    groupId: string,
  ): Promise<number>;

  /**
   * Records a child_group_history row. Service calls this AFTER mutating
   * `child.currentGroupId` via the entity and persisting via `update()`.
   */
  abstract recordGroupTransfer(
    kindergartenId: string,
    childId: string,
    fromGroupId: string | null,
    toGroupId: string,
    transferredByStaffId: string,
    reason: string | null,
    at: Date,
  ): Promise<void>;

  abstract listGroupHistory(
    kindergartenId: string,
    childId: string,
  ): Promise<ChildGroupHistoryRecord[]>;

  /**
   * Cross-tenant lookup by IIN. Used by the parent-side onboarding flow
   * (`/parent/children/link`) when the caller has no kindergarten context yet —
   * resolves the matching child(ren) so the service can decide which tenant to
   * scope into. Bypasses RLS via `app.bypass_rls=true` inside its own
   * transaction. Excludes archived children. Returns rows ordered by
   * `created_at DESC` (most recent first).
   */
  abstract findByIinCrossTenant(iin: string): Promise<Child[]>;

  /**
   * Cross-tenant batch lookup by id. Used by `IdentityQrService.scan` to
   * hydrate the snapshot list of children a parent is approved for —
   * the child rows may live in different kindergartens than the staff
   * doing the scan, so RLS is bypassed for this read. Empty `ids` returns
   * an empty array without opening a transaction.
   */
  abstract findByIdsCrossTenant(ids: string[]): Promise<Child[]>;

  // ── B21 — Lifecycle conditional UPDATEs ──────────────────────────────
  //
  // Both methods perform a single conditional UPDATE WHERE status=expected
  // RETURNING * and translate 0-row results into a typed discriminator the
  // service can map to a domain error. Non-abstract default stubs keep
  // pre-B21 service-unit fakes compiling — they must override these for
  // their own tests.

  /**
   * Conditional UPDATE `active → archived`. Writes `archived_at`,
   * `archive_reason`, `updated_at` atomically when the row is currently in
   * `status='active'`. Returns:
   *   - `archived` (with hydrated Child) on success.
   *   - `already-archived` when the row exists but status differs.
   *   - `not-found` when no row matches the (kg, id) tuple.
   *
   * `archivedByStaffId` is not persisted on the children row itself —
   * the service writes a separate `child_status_history` audit row.
   * Default impl: not-found.
   */
  archive(
    _kindergartenId: string,
    _childId: string,
    _archivedAt: Date,
    _archiveReason: string,
  ): Promise<ChildArchiveResult> {
    return Promise.resolve({ kind: 'not-found' });
  }

  /**
   * Conditional UPDATE `archived → active`. Clears `archived_at` and
   * `archive_reason`. Returns:
   *   - `reactivated` (with hydrated Child) on success.
   *   - `not-archived` when row exists but status differs.
   *   - `not-found` when no row matches the (kg, id) tuple.
   *
   * Default impl: not-found.
   */
  reactivate(
    _kindergartenId: string,
    _childId: string,
    _reactivatedAt: Date,
  ): Promise<ChildReactivateResult> {
    return Promise.resolve({ kind: 'not-found' });
  }

  /**
   * Conditional UPDATE `card_created → active`. Sets `enrollment_date` and
   * `updated_at` atomically when the row is currently in
   * `status='card_created'`. Returns:
   *   - `activated` (with hydrated Child) on success.
   *   - `not-card-created` when the row exists but status differs.
   *   - `not-found` when no row matches the (kg, id) tuple.
   *
   * Default impl: not-found. The relational impl overrides; pre-existing
   * service-unit fakes that do not exercise activation inherit this stub.
   */
  activate(
    _kindergartenId: string,
    _childId: string,
    _activatedAt: Date,
  ): Promise<ChildActivateResult> {
    return Promise.resolve({ kind: 'not-found' });
  }

  // ── B22a T3 (FINDINGS B21-T6-M3) — Monthly billing archive-race guard ─

  /**
   * Conditional existence check used by the monthly billing cron right
   * before INSERTing the per-child invoice. Acquires a row-level lock
   * (`FOR UPDATE`) on the matching child so a concurrent
   * `archive` UPDATE blocks until the invoice INSERT TX commits or
   * rolls back. This closes the narrow window where archive lands
   * between `findAllActiveAtDate` (start of run) and the per-child
   * INSERT inside `generateAndPersistInvoice`:
   *
   *   - `true`  → row exists in this kg AND `status <> 'archived'`. The
   *     row is locked for the rest of the ambient TX, so a concurrent
   *     archive can only commit AFTER the invoice INSERT completes.
   *   - `false` → row missing OR archived. Service skips the INSERT.
   *
   * MUST be called inside an open ambient transaction (the manager()
   * helper resolves to the tenant-scoped EntityManager) — otherwise
   * `FOR UPDATE` is a no-op when the implicit autocommit fires.
   *
   * Default impl: false (older test fakes get a "missing" semantic for
   * free; specs that exercise this path must override).
   */
  existsActiveByIdForUpdate(
    _kindergartenId: string,
    _childId: string,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }

  // ── B16 — DiscountTargetResolver helpers ──────────────────────────────
  // These are non-abstract default-no-op methods to keep older test
  // fakes compiling without forcing them to declare empty stubs. The
  // relational impl overrides each with the real query. Service-layer
  // callers (DiscountTargetResolver) treat empty-set returns as "no
  // children targeted" — matches the intended semantics.

  /**
   * Returns the IDs of every non-archived child in the kg. Used by
   * `DiscountTargetResolver` for the `targetType='all'` discount target.
   * Returns IDs only (not hydrated entities) — keeps the read minimal
   * for kgs with many children.
   */
  listAllActiveIdsByKg(_kindergartenId: string): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * Returns the IDs of non-archived children whose `current_group_id` is
   * in the given list. Used by `targetType='groups'`. Empty input
   * returns `[]` without a query.
   */
  listActiveIdsByGroupIds(
    _kindergartenId: string,
    _groupIds: string[],
  ): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * Filters the input `ids` to those belonging to the kg AND non-archived.
   * Used by `targetType='children'` to drop phantom (cross-tenant or
   * archived) ids before notification fan-out. Empty input returns `[]`.
   */
  findActiveIdsInKg(
    _kindergartenId: string,
    _ids: string[],
  ): Promise<string[]> {
    return Promise.resolve([]);
  }

  /**
   * Returns the IDs of non-archived children whose age in months at `now`
   * (computed from `date_of_birth`) falls within `[fromMonths,
   * toMonths]` inclusive. Used by `targetType='age_range'` discounts —
   * the actual range itself lives in `discount.conditions.age_range`,
   * the resolver pulls it out and calls this method.
   */
  listActiveIdsInKgInAgeRange(
    _kindergartenId: string,
    _fromMonths: number,
    _toMonths: number,
    _now: Date,
  ): Promise<string[]> {
    return Promise.resolve([]);
  }

  // ── B17 — Birthday content generator helper ──────────────────────────
  // Non-abstract default-no-op to keep older test fakes compiling.

  /**
   * Returns non-archived children in the kg whose `date_of_birth` matches
   * `(month, day)` regardless of year. Used by the B17 birthday-generation
   * cron to populate `content.birthday` posts at 07:00 Asia/Almaty daily.
   *
   * `month` is 1-based (1=Jan ... 12=Dec). The relational impl filters
   * via `EXTRACT(MONTH FROM date_of_birth) = $month AND
   * EXTRACT(DAY FROM date_of_birth) = $day`.
   */
  listActiveByBirthdayMonthDay(
    _kindergartenId: string,
    _month: number,
    _day: number,
  ): Promise<Child[]> {
    return Promise.resolve([]);
  }

  // ── B18 — MyTodosService helper ──────────────────────────────────────
  // Non-abstract default-no-op so older test fakes compile without
  // declaring an empty stub.

  /**
   * Returns the lightweight `{ id, fullName }` shape for every non-archived
   * child in the kg. Used by `MyTodosService.getMyTodos` to enumerate the
   * universe of children that need a fresh diagnostic — joined client-side
   * against the latest-entry-per-child map. Order: by `full_name ASC` for
   * stable presentation in the staff-app digest.
   */
  listActiveLightByKg(
    _kindergartenId: string,
  ): Promise<Array<{ id: string; fullName: string }>> {
    return Promise.resolve([]);
  }

  // ── B-DASH — Dashboard summary aggregate ──────────────────────────────

  /**
   * COUNT of children with `status = 'active'` in the kg. Default stub so
   * older in-memory test fakes compile; the relational impl overrides with a
   * real COUNT query.
   */
  countActiveByKindergarten(_kindergartenId: string): Promise<number> {
    return Promise.resolve(0);
  }
}
