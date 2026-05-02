/**
 * Plain TS view of a `user_qr_tokens` row. Lives in domain because it's the
 * contract the application/infrastructure layers use to rehydrate a QrToken
 * without leaking TypeORM types upward.
 */
export interface QrTokenState {
  id: string;
  userId: string;
  kindergartenId: string | null;
  purpose: 'identity';
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  lastScannedAt: Date | null;
}

export interface CreateQrTokenInput {
  id: string;
  userId: string;
  kindergartenId: string | null;
  purpose: 'identity';
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
}

const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * QrToken rich aggregate. POJO — no TypeORM/Nest imports. Immutable: state
 * transitions (`revoke`, `recordScan`) return a new instance instead of
 * mutating in place; this matches the opaque-token pattern (RefreshToken
 * uses similar semantics) and keeps the aggregate trivially shareable
 * across cache lookups + DB persistence on the same request.
 *
 * Invariants enforced in `create`:
 *   - `expiresAt` strictly after `issuedAt`
 *   - `tokenHash` is 64 lowercase hex chars (SHA-256 hex)
 *
 * Lifecycle:
 *   issued (active) → revoked (terminal, via revoke())
 *   issued (active) → expired (passive, via clock advancing past expiresAt)
 *
 * `recordScan` is allowed regardless of state: the service decides whether
 * to call it (e.g. only on a successful scan). Recording the scan on an
 * already-revoked token would be a service-layer bug — the entity does not
 * second-guess.
 */
export class QrToken {
  private constructor(
    readonly id: string,
    readonly userId: string,
    readonly kindergartenId: string | null,
    readonly purpose: 'identity',
    readonly tokenHash: string,
    readonly issuedAt: Date,
    readonly expiresAt: Date,
    readonly revokedAt: Date | null,
    readonly lastScannedAt: Date | null,
  ) {}

  static create(input: CreateQrTokenInput): QrToken {
    if (input.expiresAt.getTime() <= input.issuedAt.getTime()) {
      throw new Error('QrToken.create: expiresAt must be after issuedAt');
    }
    if (!TOKEN_HASH_RE.test(input.tokenHash)) {
      throw new Error(
        'QrToken.create: tokenHash must be 64 lowercase hex chars',
      );
    }
    return new QrToken(
      input.id,
      input.userId,
      input.kindergartenId,
      input.purpose,
      input.tokenHash,
      input.issuedAt,
      input.expiresAt,
      null,
      null,
    );
  }

  static fromState(state: QrTokenState): QrToken {
    return new QrToken(
      state.id,
      state.userId,
      state.kindergartenId,
      state.purpose,
      state.tokenHash,
      state.issuedAt,
      state.expiresAt,
      state.revokedAt,
      state.lastScannedAt,
    );
  }

  isRevoked(): boolean {
    return this.revokedAt !== null;
  }

  isExpired(now: Date): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  isActive(now: Date): boolean {
    return !this.isRevoked() && !this.isExpired(now);
  }

  /**
   * True if the token can no longer be relied on as-is for the next scan
   * window: revoked, expired, or expiring within `thresholdMs` from `now`.
   * Service passes the auto-refresh threshold (e.g. 1h) — the entity does
   * not hardcode a value.
   */
  shouldRefresh(now: Date, thresholdMs: number): boolean {
    if (this.isRevoked()) return true;
    if (this.isExpired(now)) return true;
    return this.expiresAt.getTime() - now.getTime() < thresholdMs;
  }

  /**
   * Returns a new QrToken with `revokedAt = now`. Throws if already revoked
   * — terminal-state guard, matches Child.archive / ChildGuardian.revoke
   * style. Calling code that needs idempotency should check `isRevoked()`
   * first.
   */
  revoke(now: Date): QrToken {
    if (this.isRevoked()) {
      throw new Error('QrToken.revoke: token already revoked');
    }
    return new QrToken(
      this.id,
      this.userId,
      this.kindergartenId,
      this.purpose,
      this.tokenHash,
      this.issuedAt,
      this.expiresAt,
      now,
      this.lastScannedAt,
    );
  }

  /**
   * Returns a new QrToken with `lastScannedAt = now`. Allowed regardless of
   * lifecycle state — the service is responsible for deciding whether a
   * scan should be recorded (only on a successful scan, never on a denied
   * one). The entity stays permissive so test setups can stamp scans on
   * historical tokens without contortions.
   */
  recordScan(now: Date): QrToken {
    return new QrToken(
      this.id,
      this.userId,
      this.kindergartenId,
      this.purpose,
      this.tokenHash,
      this.issuedAt,
      this.expiresAt,
      this.revokedAt,
      now,
    );
  }

  toState(): QrTokenState {
    return {
      id: this.id,
      userId: this.userId,
      kindergartenId: this.kindergartenId,
      purpose: this.purpose,
      tokenHash: this.tokenHash,
      issuedAt: this.issuedAt,
      expiresAt: this.expiresAt,
      revokedAt: this.revokedAt,
      lastScannedAt: this.lastScannedAt,
    };
  }
}
