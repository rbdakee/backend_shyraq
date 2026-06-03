export interface CreateRefreshInput {
  userId: string;
  kindergartenId: string | null;
  tokenHash: string;
  deviceId: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  /** App audience baked into the session ('parent'|'staff'|'admin'); null for legacy. */
  audience: string | null;
}

export interface RotateOpts {
  tokenHash: string;
  now: Date;
  newTokenHash: string;
  newExpiresAt: Date;
  deviceIdOverride: string | null;
  ipAddressOverride: string | null;
}

export interface RotateResult {
  userId: string;
  kindergartenId: string | null;
  /**
   * Audience stored on the rotated (original) row, carried forward onto the
   * new row. NULL for legacy rows issued before the audience column existed —
   * callers treat NULL as "no audience filter" to keep old sessions working.
   */
  audience: string | null;
}

export abstract class RefreshTokenRepository {
  abstract create(input: CreateRefreshInput): Promise<void>;
  /**
   * Atomically revokes the refresh token identified by `tokenHash` and inserts
   * a fresh row with `newTokenHash`, carrying forward userId+kindergartenId.
   * Returns null if the token is unknown, expired, or already revoked.
   */
  abstract rotate(opts: RotateOpts): Promise<RotateResult | null>;
  abstract revokeByHash(tokenHash: string, now: Date): Promise<void>;
  abstract revokeAllByUserId(userId: string, now: Date): Promise<void>;

  /**
   * Returns true when the (`userId`, `deviceId`) pair has at least one active
   * refresh-token row (`revoked_at IS NULL AND expires_at > now`). Used by
   * Identity-QR scan to confirm that the calling staff really owns the
   * `device_id` they're rate-limiting under — without this check a staff
   * could spoof a different device id in the header to bypass the
   * 60-scans/min budget.
   *
   * Runs under the ambient tenant GUC (no internal RLS bypass). Caller's
   * refresh_tokens row's `kindergarten_id` is set at OTP-verify /
   * role-select to match the caller's JWT `kindergarten_id`, so the
   * row passes RLS naturally for the same-user same-kg lookup pattern
   * this method serves.
   */
  abstract hasActiveSessionForDevice(
    userId: string,
    deviceId: string,
    now: Date,
  ): Promise<boolean>;
}
