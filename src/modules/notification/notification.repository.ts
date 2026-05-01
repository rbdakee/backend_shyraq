import { EntityManager } from 'typeorm';

/**
 * Row-shape for a new history record. The dispatcher builds these from a
 * per-event template (`title_i18n` / `body_i18n` / `data`) and INSERTs them
 * in bulk inside the worker's tenant-bypass TX.
 */
export interface NotificationCreateInput {
  /**
   * Optional client-supplied id. Omit to let the DB default
   * `gen_random_uuid()` fill it.
   */
  id?: string;
  kindergartenId: string;
  userId: string;
  eventKey: string;
  titleI18n: Record<string, string>;
  bodyI18n: Record<string, string>;
  data: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Port for the `notifications` history table. T4 only needs `createMany`
 * (one INSERT per outbox-event covering all in-app-enabled recipients).
 * T7 will extend with `findByUserId` (paginated list with `unread_only`),
 * `markRead`, and `markAllRead` for the parent-app notifications page.
 */
export abstract class NotificationRepository {
  /**
   * Bulk-insert history rows. Empty input is a no-op (no DB round-trip).
   *
   * `manager` should be the worker TX's manager (where
   * `app.bypass_rls = 'true'` is set) — when called from outside the worker
   * (e.g. integration tests) the implementation falls back to the
   * `tenantStorage` manager and finally to the connection-level manager.
   */
  abstract createMany(
    rows: NotificationCreateInput[],
    manager?: EntityManager,
  ): Promise<void>;
}
