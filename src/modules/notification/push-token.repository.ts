/**
 * Subset of `push_tokens` columns the dispatcher needs for per-user push
 * fan-out. T7 will extend the port with full CRUD (register/delete/list)
 * for the `POST /push-tokens` and `DELETE /push-tokens/:id` endpoints; T4
 * keeps the surface minimal so the dispatcher only depends on the read.
 */
export interface PushTokenSummary {
  id: string;
  userId: string;
  platform: 'ios' | 'android' | 'web';
  token: string;
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
}
