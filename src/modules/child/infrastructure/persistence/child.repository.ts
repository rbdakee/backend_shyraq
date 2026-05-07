import { Child } from '../../domain/entities/child.entity';

export type ChildStatusFilter = 'card_created' | 'active' | 'archived';

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
}
