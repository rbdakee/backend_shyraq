/**
 * QR token cache. Two paired Redis keys per active QR:
 *   - `qr:token:{plaintext} → userId` (TTL = remaining token lifetime).
 *     Used by `/staff/qr/scan` to map a presented plaintext to a user-id
 *     without hitting the DB on the hot path. Plaintext-keyed because the
 *     scan path receives the plaintext from the client.
 *   - `qr:user:{userId}:identity → plaintext` (same TTL).
 *     Used by `GET /users/me/qr` to recover the active plaintext on a
 *     subsequent GET inside the reuse window so the same token is returned
 *     instead of always minting (the locked contract: reuse if the active
 *     row's `expires_at - now > 1h`). User-keyed because the issuance path
 *     only knows the userId (the previous plaintext was discarded after
 *     the previous response).
 *
 * Cache miss handling: both keys are advisory. `scan` always re-validates
 * via the DB row's `revoked_at` / `expires_at` (DB is SoT). `issueOrRefresh`
 * falls through to mint-fresh when the user-key is missing OR when the DB
 * row no longer matches the cache (revoked / expired / about-to-expire).
 *
 * Admin bulk-revoke (`POST /admin/qr/revoke-all/:userId`) clears
 * `qr:user:{userId}:identity` (key reachable by userId), which is a real
 * UX improvement: the user's next GET mints fresh immediately rather than
 * returning a soon-to-410 reused token. The plaintext-keyed entry
 * (`qr:token:{plaintext}`) cannot be cleared from the admin path (admin
 * has only the hash), but it stays correct because `scan`'s DB-recheck
 * surfaces `qr_token_revoked` (410) regardless.
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

  /**
   * Sets `qr:user:{userId}:identity → plaintext` with `EX ttlSeconds`.
   * Paired with `setToken` on every successful mint so the next
   * `issueOrRefresh` for the same user can reuse the active plaintext
   * without rerolling the token.
   */
  abstract setUserActiveToken(
    userId: string,
    plaintext: string,
    ttlSeconds: number,
  ): Promise<void>;

  /** Returns the cached active plaintext for `userId` or `null` on miss. */
  abstract getUserActiveToken(userId: string): Promise<string | null>;

  /**
   * Deletes `qr:user:{userId}:identity`. Called by admin bulk-revoke so
   * the next user GET mints fresh (the just-revoked plaintext is no
   * longer reusable).
   */
  abstract clearUserActiveToken(userId: string): Promise<void>;
}
