import { QrToken } from '../../domain/entities/qr-token.entity';

/**
 * Persistence port for the Identity QR aggregate. Methods exchange domain
 * objects (`QrToken`), not TypeORM entities — the relational implementation
 * owns the mapper translation.
 *
 * Cross-tenant by design — the `user_qr_tokens` table has no
 * `tenant_isolation` policy and no FORCE RLS. The relational implementation
 * still uses `tenantStorage.getStore()?.entityManager` when available so
 * its work participates in the ambient TX from `TenantContextInterceptor`
 * (for endpoints that have a tenant scope) and falls back to the default
 * pool manager otherwise (for cross-tenant endpoints like
 * `GET /users/me/qr` that run outside `KindergartenScopeGuard`).
 */
export abstract class IdentityQrRepository {
  /**
   * Loads the (at most one) currently-active token for a `(userId, purpose)`
   * pair: not revoked AND not yet expired at `now`. Active-uniqueness is
   * enforced by the service via revoke-old-then-insert-new TX, but this
   * method tolerates the race window where two non-revoked rows momentarily
   * exist by returning the freshest one.
   */
  abstract findActiveByUserAndPurpose(
    userId: string,
    purpose: 'identity',
    now: Date,
  ): Promise<QrToken | null>;

  abstract findByTokenHash(tokenHash: string): Promise<QrToken | null>;

  abstract create(token: QrToken): Promise<QrToken>;

  /**
   * Bulk-revoke all not-yet-revoked tokens for a `(userId, purpose)` pair.
   * Returns the list of `token_hash`es that were just stamped — useful for
   * audit logging. Note the cache layer keys plaintext, not hash, so admin
   * bulk-revoke cannot evict matching cache entries; the next scan still
   * checks the DB and gets `qr_token_revoked`. The hashes are surfaced for
   * observability, not for cache invalidation.
   */
  abstract revokeAllByUser(
    userId: string,
    purpose: 'identity',
    now: Date,
  ): Promise<{ revokedHashes: string[] }>;

  abstract revokeById(id: string, now: Date): Promise<void>;

  abstract updateLastScannedAt(id: string, now: Date): Promise<void>;

  /**
   * Acquires a transaction-scoped Postgres advisory lock keyed on the user.
   * Idempotent within a TX; released automatically on TX commit/rollback.
   * Used by the issueOrRefresh flow to serialize concurrent
   * `GET /users/me/qr` calls for the same user — without this lock two
   * simultaneous calls both see "no active row", both run revoke-all (no-op),
   * then race on INSERT into the partial unique idx
   * `(user_id, purpose) WHERE revoked_at IS NULL` and the second crashes
   * with PG 23505 → 500. With the lock the second caller blocks until the
   * first commits, then either reuses the just-minted token (if the cache
   * is now warm and the row is fresh) or revokes-and-mints cleanly.
   *
   * Implementations should silently no-op when no ambient TX is available
   * (CLI scripts, integration tests outside the HTTP pipeline). The
   * race-integration spec exercises the real lock against PG.
   */
  abstract acquireUserAdvisoryLock(userId: string): Promise<void>;
}
