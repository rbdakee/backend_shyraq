import { ChildDailyStatus } from '../../domain/entities/child-daily-status.entity';

/**
 * Port over `child_daily_status`. The `(child_id, date)` unique index is the
 * idempotency key — `upsert` is the only write primitive: it INSERTs or
 * UPDATEs in a single statement and returns the resulting domain entity.
 *
 * Read access is via `findByChildAndDate` for the conditional-promotion path
 * inside checkIn (read-then-write), and for T4's read endpoints.
 */
export abstract class ChildDailyStatusRepository {
  abstract findByChildAndDate(
    kindergartenId: string,
    childId: string,
    date: string,
  ): Promise<ChildDailyStatus | null>;

  /**
   * INSERT on a fresh `(child_id, date)` tuple, UPDATE-on-conflict (replacing
   * status / note / set_by / updated_at) when one already exists. Used by
   * `setDailyStatus`. Returns the row in its post-write shape.
   */
  abstract upsert(
    kindergartenId: string,
    daily: ChildDailyStatus,
  ): Promise<ChildDailyStatus>;

  /**
   * Persist an already-loaded row whose status was promoted via
   * `markPresent()`. Used by checkIn after a read+mutate; idempotent because
   * the caller only calls this when `markPresent()` returned true.
   */
  abstract save(
    kindergartenId: string,
    daily: ChildDailyStatus,
  ): Promise<ChildDailyStatus>;

  /**
   * Conditional UPDATE for the check-in promotion path. Atomically flips
   * `status` to `present` (and updates `set_by` + `updated_at`) ONLY when
   * the row's current status is in `{absent, late}`. Returns the
   * post-write row when the update happened, or the existing row
   * (unchanged) when a concurrent explicit setter already wrote `sick` /
   * `on_vacation` / `early_pickup` / `present`.
   *
   * Replaces the racy read-then-save sequence in `AttendanceService.checkIn`
   * step 3: between `findByChildAndDate` returning `absent` and the
   * subsequent `save(... PRESENT)`, a parent or admin can flip the row to
   * `sick` via `setDailyStatus`. The unconditional `save` would then
   * overwrite the explicit status with `present`. The conditional UPDATE
   * here makes the persistence step atomic.
   */
  abstract updatePresentIfAbsentOrLate(
    kindergartenId: string,
    childId: string,
    date: string,
    setBy: string | null,
    now: Date,
  ): Promise<{ updated: boolean; current: ChildDailyStatus | null }>;

  /**
   * Paged list of daily_status rows for a kindergarten with optional filters.
   * Used by admin and T4 list endpoints.
   */
  abstract list(
    kindergartenId: string,
    filter: ListDailyStatusFilter,
  ): Promise<ChildDailyStatus[]>;

  // ── B-DASH — Dashboard attendance-today aggregate ─────────────────────

  /**
   * Histogram of child_daily_status by status for one calendar `date`
   * (YYYY-MM-DD), optionally scoped to a group via
   * `children.current_group_id`. Returns `{ status: count }`.
   *
   * Special-case for the `absent` bucket (§2.3): a child whose
   * daily_status is `absent` but who has a `check_in` event within the
   * Asia/Almaty day window [dayStartIso, dayEndExclusiveIso) is NOT counted
   * as absent. This NOT-EXISTS exclusion lives here (child_daily_status and
   * attendance_events are both in the attendance bounded context) so the
   * service stays a pure composition. Other statuses are a plain
   * GROUP BY status.
   *
   * Default stub so older in-memory test fakes compile; the relational
   * impl overrides.
   */
  countByStatusForDate(
    _kindergartenId: string,
    _date: string,
    _dayStartIso: string,
    _dayEndExclusiveIso: string,
    _groupId?: string,
  ): Promise<Record<string, number>> {
    return Promise.resolve({});
  }
}

export interface ListDailyStatusFilter {
  childId?: string;
  /**
   * Filter by child's current group (children.current_group_id). Used by
   * the admin dashboard endpoint `GET /admin/dashboard/attendance-today`.
   * Children transferred between groups are reported under their *current*
   * group, mirroring the listByGroup behaviour of attendance_events.
   */
  groupId?: string;
  /** Inclusive lower bound (YYYY-MM-DD). */
  from?: string;
  /** Inclusive upper bound (YYYY-MM-DD). */
  to?: string;
  limit?: number;
  offset?: number;
}
