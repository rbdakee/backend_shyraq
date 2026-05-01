/**
 * Subset of `push_tokens` columns the dispatcher needs for per-user push
 * fan-out. T7 extended the port with full CRUD (register/delete/list)
 * for the `POST /push-tokens` and `DELETE /push-tokens/:id` endpoints; T4
 * kept the surface minimal so the dispatcher only depends on the read.
 */
export interface PushTokenSummary {
  id: string;
  userId: string;
  platform: 'ios' | 'android' | 'web';
  token: string;
}

export interface PushToken {
  id: string;
  userId: string;
  platform: 'ios' | 'android' | 'web';
  token: string;
  appVersion: string | null;
  deviceId: string | null;
  lastSeenAt: Date;
  createdAt: Date;
}

export interface PushTokenUpsertInput {
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  appVersion?: string | null;
  deviceId?: string | null;
}

export abstract class PushTokenRepository {
  /**
   * Bulk-load tokens for a list of users. Returns a flat array — multiple
   * tokens per user are normal (one user, multiple devices). Empty `userIds`
   * returns an empty array without hitting the DB. The implementation must
   * NOT depend on RLS / tenant scope: `push_tokens` is a global table keyed
   * on `user_id` only.
   */
  abstract findByUserIds(userIds: string[]): Promise<PushTokenSummary[]>;

  /**
   * Upsert a device token for a user. If the `(user_id, token)` pair already
   * exists, update `last_seen_at`, `app_version`, and `device_id`. Otherwise
   * INSERT a new row. Global table — no RLS involved.
   */
  abstract upsert(input: PushTokenUpsertInput): Promise<PushToken>;

  /**
   * Delete a push-token row only if it belongs to `userId`. Returns `true` if
   * a row was deleted, `false` if not found (including wrong-owner). The
   * caller (`NotificationService`) maps `false` → `PushTokenNotFoundError`.
   */
  abstract deleteByIdAndUserId(id: string, userId: string): Promise<boolean>;
}
