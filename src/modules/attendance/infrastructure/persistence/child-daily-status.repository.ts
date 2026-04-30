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
   * Paged list of daily_status rows for a kindergarten with optional filters.
   * Used by admin and T4 list endpoints.
   */
  abstract list(
    kindergartenId: string,
    filter: ListDailyStatusFilter,
  ): Promise<ChildDailyStatus[]>;
}

export interface ListDailyStatusFilter {
  childId?: string;
  /** Inclusive lower bound (YYYY-MM-DD). */
  from?: string;
  /** Inclusive upper bound (YYYY-MM-DD). */
  to?: string;
  limit?: number;
  offset?: number;
}
