export interface SaasRefreshTokenState {
  id: string;
  saasUserId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * SaaS-operator refresh token aggregate. Kept deliberately separate from the
 * tenant-user RefreshToken (D1 no-polymorphism).
 */
export class SaasRefreshToken {
  private constructor(
    readonly id: string,
    readonly saasUserId: string,
    readonly tokenHash: string,
    readonly expiresAt: Date,
    private _revokedAt: Date | null,
  ) {}

  static hydrate(state: SaasRefreshTokenState): SaasRefreshToken {
    return new SaasRefreshToken(
      state.id,
      state.saasUserId,
      state.tokenHash,
      state.expiresAt,
      state.revokedAt,
    );
  }

  get revokedAt(): Date | null {
    return this._revokedAt;
  }

  isActive(now: Date): boolean {
    if (this._revokedAt !== null) return false;
    return this.expiresAt.getTime() > now.getTime();
  }

  revoke(now: Date): void {
    if (this._revokedAt !== null) return;
    this._revokedAt = now;
  }
}
