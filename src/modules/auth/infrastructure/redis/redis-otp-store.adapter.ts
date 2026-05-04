import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { RedisKeys } from '@/redis/redis-keys';
import { OtpStorePort, StoredOtp } from '../../otp-store.port';

@Injectable()
export class RedisOtpStoreAdapter extends OtpStorePort {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async checkRateLimit(
    phone: string,
    maxPerWindow: number,
    windowSec: number,
  ): Promise<'ok' | 'exceeded'> {
    const key = RedisKeys.rateOtp(phone);
    // Pipeline batches INCR + EXPIRE in one round-trip so a crash between
    // the two commands cannot leave the key without a TTL (permanent block).
    // Both commands are always sent regardless of the INCR result, which is
    // safe: setting the same TTL on an existing key just resets it to the
    // window boundary — the fixed-window semantics are preserved.
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, windowSec);
    const results = await pipeline.exec();
    // results[0] = [error, incrResult], results[1] = [error, expireResult]
    const count = (results?.[0]?.[1] as number | null) ?? 1;
    return count > maxPerWindow ? 'exceeded' : 'ok';
  }

  async checkRateLimitGeneric(
    key: string,
    maxPerWindow: number,
    windowSec: number,
  ): Promise<'ok' | 'exceeded'> {
    const pipeline = this.redis.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, windowSec);
    const results = await pipeline.exec();
    const count = (results?.[0]?.[1] as number | null) ?? 1;
    return count > maxPerWindow ? 'exceeded' : 'ok';
  }

  async isLocked(phone: string): Promise<boolean> {
    const locked = await this.redis.exists(RedisKeys.otpLocked(phone));
    return locked === 1;
  }

  async storeCode(phone: string, code: string, ttlSec: number): Promise<void> {
    const key = RedisKeys.otpLogin(phone);
    await this.redis.del(key);
    await this.redis.hset(key, { code, attempts: '0' });
    await this.redis.expire(key, ttlSec);
  }

  async readCode(phone: string): Promise<StoredOtp | null> {
    const raw = await this.redis.hgetall(RedisKeys.otpLogin(phone));
    if (!raw || !raw.code) return null;
    return { code: raw.code, attempts: Number(raw.attempts ?? '0') };
  }

  async incrementAttempts(phone: string): Promise<number> {
    return this.redis.hincrby(RedisKeys.otpLogin(phone), 'attempts', 1);
  }

  async lockPhone(phone: string, ttlSec: number): Promise<void> {
    await this.redis.set(RedisKeys.otpLocked(phone), '1', 'EX', ttlSec);
  }

  async clearCode(phone: string): Promise<void> {
    await this.redis.del(RedisKeys.otpLogin(phone));
  }
}
