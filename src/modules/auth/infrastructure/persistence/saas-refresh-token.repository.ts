export interface CreateSaasRefreshInput {
  saasUserId: string;
  tokenHash: string;
  deviceId: string | null;
  ipAddress: string | null;
  expiresAt: Date;
}

export interface RotateSaasOpts {
  tokenHash: string;
  now: Date;
  newTokenHash: string;
  newExpiresAt: Date;
  deviceIdOverride: string | null;
  ipAddressOverride: string | null;
}

export interface RotateSaasResult {
  saasUserId: string;
}

export abstract class SaasRefreshTokenRepository {
  abstract create(input: CreateSaasRefreshInput): Promise<void>;
  abstract rotate(opts: RotateSaasOpts): Promise<RotateSaasResult | null>;
  abstract revokeByHash(tokenHash: string, now: Date): Promise<void>;
  abstract revokeAllBySaasUserId(saasUserId: string, now: Date): Promise<void>;
}
