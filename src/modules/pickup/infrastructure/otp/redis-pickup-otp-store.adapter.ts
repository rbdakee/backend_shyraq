import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import {
  pickupOtpAttemptsRedisKey,
  pickupOtpLockRedisKey,
  pickupOtpRedisKey,
} from './pickup-otp-cache.namespace';
import { PickupOtpStorePort, StoredPickupOtp } from './pickup-otp-store.port';

/**
 * Redis-backed adapter for `PickupOtpStorePort`. Mirrors the
 * `RedisOtpStoreAdapter` shape but operates in the `otp:pickup:*`
 * namespace and keys by `pickup_request.id` rather than phone.
 *
 * The code entry stores `{ code, attempts }` as a hash to keep the existing
 * pattern; failed-attempt increments use the same hash so the counter
 * outlives the code on partial reads.
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
    await this.redis.del(key);
    await this.redis.hset(key, { code, attempts: '0' });
    await this.redis.expire(key, ttlSec);
    // Reset the standalone attempts counter too so a resend gives the
    // trusted person a fresh 3-strike budget.
    await this.redis.del(pickupOtpAttemptsRedisKey(requestId));
    return key;
  }

  async readCode(requestId: string): Promise<StoredPickupOtp | null> {
    const raw = await this.redis.hgetall(pickupOtpRedisKey(requestId));
    if (!raw || !raw.code) return null;
    return { code: raw.code, attempts: Number(raw.attempts ?? '0') };
  }

  async clearCode(requestId: string): Promise<void> {
    await this.redis.del(pickupOtpRedisKey(requestId));
  }

  async incrementAttempts(requestId: string): Promise<number> {
    return this.redis.hincrby(pickupOtpRedisKey(requestId), 'attempts', 1);
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
}
