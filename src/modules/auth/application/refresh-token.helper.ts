import { createHash, randomBytes } from 'node:crypto';

/**
 * Refresh-token cryptography helpers — kept module-private and pure so they
 * can be shared between AuthService (issuance / rotation) and unit tests.
 *
 * Design choices (carried over from B1):
 *  - Refresh tokens are opaque 64-char hex strings (32 random bytes).
 *  - We never store the raw value — only its SHA-256 hash. Lookup is by hash.
 *  - Expiry is stamped at issuance from a TTL in days from `auth.config.ts`.
 */
export function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function computeRefreshExpiresAt(now: Date, ttlDays: number): Date {
  return new Date(now.getTime() + ttlDays * 86_400 * 1000);
}
