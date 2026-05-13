import {
  ChildStatusHistory,
  ChildStatusHistoryState,
} from '../../domain/entities/child-status-history.entity';

export interface ChildStatusHistoryPage {
  items: ChildStatusHistory[];
  total: number;
}

/**
 * Port over the `child_status_history` audit table (B22a T9).
 *
 * Kept as its own port (rather than extending `ChildRepository`) because
 * the audit table has its own lifecycle and a separate test surface — the
 * archive/reactivate atomicity test in the service spec injects a fake
 * that fails on `recordStatusChange` to verify rollback, which is much
 * cleaner against a single-purpose port.
 *
 * Both methods MUST run inside the ambient tenant TX (the implementation
 * resolves `tenantStorage.getStore()?.entityManager`). The `recordStatusChange`
 * INSERT and the conditional `UPDATE children` issued by the service share
 * the same EntityManager so a failure in either rolls both back.
 */
export abstract class ChildStatusHistoryRepository {
  /**
   * Append a new history row. Inputs are domain-shaped (ChildStatusHistoryState).
   * The relational impl reads back any DB-defaulted columns through
   * `RETURNING *` so the persisted `id`/`created_at` are reflected — but
   * service callers do not typically need the returned row.
   */
  abstract recordStatusChange(
    kindergartenId: string,
    record: ChildStatusHistoryState,
  ): Promise<void>;

  /**
   * Paginated list ordered by `changed_at DESC` (newest first). `limit`
   * is bounded by the controller layer (default 50, max 200 per
   * `docs/endpoints.md` §2.7.4).
   */
  abstract listForChild(
    kindergartenId: string,
    childId: string,
    limit: number,
    offset: number,
  ): Promise<ChildStatusHistoryPage>;
}
