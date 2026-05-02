/**
 * Plaintext-keyed QR token cache. Maps `qr:token:{plaintext} → userId`,
 * letting the staff-scan path skip the DB on cache hits.
 *
 * Design note: the cache is keyed on plaintext, but admin bulk-revoke
 * `POST /admin/qr/revoke-all/:userId` only has the SHA-256 `token_hash`
 * (admin never sees plaintext). There is no reverse hash→plaintext index
 * by design (owning a hash should not let you reconstruct the plaintext).
 *
 * Resolution:
 *   - The auto-refresh path on `GET /users/me/qr` *can* call `revoke()`
 *     because the server has the just-revoked plaintext in scope.
 *   - The admin bulk-revoke path *does not* invalidate cache. Cache TTL
 *     never exceeds 24h (the token TTL), and `scan` always re-checks the
 *     DB row's `revoked_at` after a cache hit — DB is the source of truth.
 */
export abstract class QrTokenCachePort {
  /** Sets `qr:token:{plaintext} → userId` with `EX ttlSeconds`. */
  abstract setToken(
    plaintext: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<void>;

  /** Returns the cached `userId` or `null` on miss. */
  abstract lookup(plaintext: string): Promise<string | null>;

  /** Deletes the plaintext entry — used by the user-driven refresh path. */
  abstract revoke(plaintext: string): Promise<void>;
}
