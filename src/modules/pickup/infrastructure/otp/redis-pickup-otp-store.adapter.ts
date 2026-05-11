import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import {
  pickupOtpAttemptsRedisKey,
  pickupOtpLockRedisKey,
  pickupOtpRedisKey,
} from './pickup-otp-cache.namespace';
import { PickupOtpStorePort, StoredPickupOtp } from './pickup-otp-store.port';

const ATTEMPTS_TTL_SEC = 30 * 60;

/**
 * Redis-backed adapter for `PickupOtpStorePort`. Mirrors the
 * `RedisOtpStoreAdapter` shape but operates in the `otp:pickup:*`
 * namespace and keys by `pickup_request.id` rather than phone.
 *
 * Two keys per request id:
 *   - `otp:pickup:{requestId}`         — the code (string), TTL = pickup
 *                                        expires_at - now (~30 min).
 *   - `otp:pickup:attempts:{requestId}`— failed-attempt counter, TTL
 *                                        equal to the lock TTL so
 *                                        attempts outlive the code on
 *                                        TTL eviction (T7 fix M6).
 *
 * The previous shape stored `{ code, attempts }` together as a hash,
 * which reset the attempts counter every time the code TTL expired —
 * an attacker could throttle just below the lock threshold, wait for
 * Redis to evict the hash, and then start over with a fresh 3-strike
 * budget on the same request id. Splitting the keys gives `attempts`
 * its own lifecycle.
 */
@Injectable()
export class RedisPickupOtpStoreAdapter extends PickupOtpStorePort {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async storeCode(
    requestId: string,
    code: string,
    ttlSec: number,
  ): Promise<string> {
    const key = pickupOtpRedisKey(requestId);
    // Pure string entry now (was hash with attempts inline). Plain SET
    // is atomic w/ EX so we don't need a separate EXPIRE round-trip.
    await this.redis.set(key, code, 'EX', ttlSec);
    // Reset the standalone attempts counter so a resend gives the
    // trusted person a fresh 3-strike budget.
    await this.redis.del(pickupOtpAttemptsRedisKey(requestId));
    return key;
  }

  async readCode(requestId: string): Promise<StoredPickupOtp | null> {
    const code = await this.redis.get(pickupOtpRedisKey(requestId));
    if (!code) return null;
    const attempts = await this.getFailedAttempts(requestId);
    return { code, attempts };
  }

  async clearCode(requestId: string): Promise<void> {
    await this.redis.del(pickupOtpRedisKey(requestId));
  }

  async incrementAttempts(requestId: string): Promise<number> {
    const key = pickupOtpAttemptsRedisKey(requestId);
    // Pipeline batches INCR + EXPIRE in one Redis round-trip so a crash
    // between the two commands cannot leave the key without a TTL
    // (permanent lock of the request-id budget). Mirrors auth adapter.
    const pl = this.redis.pipeline();
    pl.incr(key);
    pl.expire(key, ATTEMPTS_TTL_SEC);
    const results = await pl.exec();
    return (results?.[0]?.[1] as number | null) ?? 1;
  }

  async lockRequest(requestId: string, lockTtlSec: number): Promise<void> {
    await this.redis.set(
      pickupOtpLockRedisKey(requestId),
      '1',
      'EX',
      lockTtlSec,
    );
  }

  async isLocked(requestId: string): Promise<boolean> {
    const v = await this.redis.exists(pickupOtpLockRedisKey(requestId));
    return v === 1;
  }

  private async getFailedAttempts(requestId: string): Promise<number> {
    const raw = await this.redis.get(pickupOtpAttemptsRedisKey(requestId));
    return raw ? Number(raw) : 0;
  }
}
