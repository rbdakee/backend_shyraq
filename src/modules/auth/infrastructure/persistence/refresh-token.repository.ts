export interface CreateRefreshInput {
  userId: string;
  kindergartenId: string | null;
  tokenHash: string;
  deviceId: string | null;
  ipAddress: string | null;
  expiresAt: Date;
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
   * Bypass-RLS internally because the row's `kindergarten_id` may be null
   * or different from the active tenant; the lookup is by user+device only.
   */
  abstract hasActiveSessionForDevice(
    userId: string,
    deviceId: string,
    now: Date,
  ): Promise<boolean>;
}
