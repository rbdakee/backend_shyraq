import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import {
  ParentRequestOtpStorePort,
  StoredParentRequestOtp,
} from './parent-request-otp-store.port';

const ROOT = 'otp:request:trusted-person' as const;
const ATTEMPTS_TTL_SEC = 30 * 60;

function codeKey(userId: string): string {
  return `${ROOT}:${userId}`;
}

function attemptsKey(userId: string): string {
  return `${ROOT}:attempts:${userId}`;
}

function lockKey(userId: string): string {
  return `${ROOT}:lock:${userId}`;
}

/**
 * Redis-backed adapter for `ParentRequestOtpStorePort`. Mirrors the
 * `RedisPickupOtpStoreAdapter` shape but operates in the
 * `otp:request:trusted-person:*` namespace and keys by `requesterUserId`.
 *
 * Three keys per user id (matches B11 T7 fix M6 split):
 *   - `otp:request:trusted-person:{userId}`         — the code (string), TTL 300s
 *   - `otp:request:trusted-person:attempts:{userId}` — failed-attempt counter
 *   - `otp:request:trusted-person:lock:{userId}`     — back-off lock
 *
 * Splitting `attempts` from the code entry keeps the failed-attempt budget
 * alive across code-TTL eviction (otherwise an attacker could throttle just
 * below the lock threshold and wait for Redis to wipe the counter).
 */
@Injectable()
export class RedisParentRequestOtpStoreAdapter extends ParentRequestOtpStorePort {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async storeCode(
    userId: string,
    code: string,
    ttlSec: number,
  ): Promise<string> {
    const key = codeKey(userId);
    await this.redis.set(key, code, 'EX', ttlSec);
    await this.redis.del(attemptsKey(userId));
    return key;
  }

  async readCode(userId: string): Promise<StoredParentRequestOtp | null> {
    const code = await this.redis.get(codeKey(userId));
    if (!code) return null;
    const attempts = await this.getFailedAttempts(userId);
    return { code, attempts };
  }

  async clearCode(userId: string): Promise<void> {
    await this.redis.del(codeKey(userId));
  }

  async incrementAttempts(userId: string): Promise<number> {
    const key = attemptsKey(userId);
    const n = await this.redis.incr(key);
    if (n === 1) {
      await this.redis.expire(key, ATTEMPTS_TTL_SEC);
    }
    return n;
  }

  async lockUser(userId: string, lockTtlSec: number): Promise<void> {
    await this.redis.set(lockKey(userId), '1', 'EX', lockTtlSec);
  }

  async isLocked(userId: string): Promise<boolean> {
    const v = await this.redis.exists(lockKey(userId));
    return v === 1;
  }

  private async getFailedAttempts(userId: string): Promise<number> {
    const raw = await this.redis.get(attemptsKey(userId));
    return raw ? Number(raw) : 0;
  }
}
