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

export interface NotificationRow {
  id: string;
  kindergartenId: string;
  userId: string;
  eventKey: string;
  titleI18n: Record<string, string>;
  bodyI18n: Record<string, string>;
  data: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationCursor {
  createdAt: Date;
  id: string;
}

export interface ListNotificationsInput {
  kindergartenId: string;
  userId: string;
  unreadOnly: boolean;
  limit: number;
  cursor?: NotificationCursor;
}

/**
 * Port for the `notifications` history table. T4 only had `createMany`
 * (one INSERT per outbox-event covering all in-app-enabled recipients).
 * T7 adds `listForUser`, `markRead`, and `markAllRead` for the
 * parent-app notifications page.
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

  /**
   * Paginated list of notifications for a user within a tenant. Ordered
   * `created_at DESC, id DESC` for stable cursor-based pagination. RLS
   * enforces tenant scope; `kindergartenId` is passed explicitly as
   * defense-in-depth. Uses `tenantStorage` manager so the per-request GUC
   * is in effect.
   */
  abstract listForUser(
    input: ListNotificationsInput,
  ): Promise<NotificationRow[]>;

  /**
   * Set `read_at = NOW()` on a single notification owned by `userId` in the
   * given tenant. Returns the updated row, or `null` if not found / wrong
   * owner.
   */
  abstract markRead(input: {
    kindergartenId: string;
    id: string;
    userId: string;
  }): Promise<NotificationRow | null>;

  /**
   * Mark all unread notifications for `userId` in the given tenant as read.
   * Returns the count of rows updated. Idempotent — calling again returns 0.
   */
  abstract markAllRead(input: {
    kindergartenId: string;
    userId: string;
  }): Promise<number>;
}
