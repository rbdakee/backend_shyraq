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
}
