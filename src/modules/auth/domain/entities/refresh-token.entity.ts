export interface RefreshTokenState {
  id: string;
  userId: string;
  kindergartenId: string | null;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

/**
 * User-bound refresh token aggregate. Separate from SaasRefreshToken
 * intentionally (D1 no-polymorphism) — two different tables with distinct
 * subject foreign keys and lifecycles.
 */
export class RefreshToken {
  private constructor(
    readonly id: string,
    readonly userId: string,
    readonly kindergartenId: string | null,
    readonly tokenHash: string,
    readonly expiresAt: Date,
    private _revokedAt: Date | null,
  ) {}

  static hydrate(state: RefreshTokenState): RefreshToken {
    return new RefreshToken(
      state.id,
      state.userId,
      state.kindergartenId,
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
