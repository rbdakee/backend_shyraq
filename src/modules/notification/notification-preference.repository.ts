/**
 * Effective preference flags for a user × event_key pair, as returned by
 * `findByUserIdsAndEventKey`. When the row is absent the dispatcher assumes
 * `push_enabled=true, in_app_enabled=true` — every user opts-in by default
 * until they explicitly mute via `PATCH /notifications/preferences` (T7).
 */
export interface NotificationPreferenceFlags {
  push_enabled: boolean;
  in_app_enabled: boolean;
}

export interface NotificationPreference {
  id: string;
  userId: string;
  eventKey: string;
  pushEnabled: boolean;
  inAppEnabled: boolean;
  updatedAt: Date;
}

export interface UpsertPreferenceItem {
  eventKey: string;
  pushEnabled?: boolean;
  inAppEnabled?: boolean;
}

export abstract class NotificationPreferenceRepository {
  /**
   * Bulk-load the (user_id, event_key) preference rows for a list of users
   * filtered to a single event_key. Returned as a `Map<userId, flags>` for
   * O(1) lookup inside the dispatcher's per-user loop. Users without a row
   * are absent from the map — the dispatcher applies the
   * `push_enabled=true, in_app_enabled=true` default. T7 added
   * `upsertMany` for the PATCH endpoint.
   */
  abstract findByUserIdsAndEventKey(
    userIds: string[],
    eventKey: string,
  ): Promise<Map<string, NotificationPreferenceFlags>>;

  /**
   * Return all stored preference rows for a user. Users with no rows get
   * an empty array — the service layer merges with defaults. Global table
   * (no RLS).
   */
  abstract listForUser(userId: string): Promise<NotificationPreference[]>;

  /**
   * Upsert preferences per (user_id, event_key). Only supplied flags are
   * modified; omitted flags retain their existing value (or default `true`
   * on first insert). Returns the full updated set of rows for the user.
   */
  abstract upsertMany(
    userId: string,
    items: UpsertPreferenceItem[],
  ): Promise<NotificationPreference[]>;
}
