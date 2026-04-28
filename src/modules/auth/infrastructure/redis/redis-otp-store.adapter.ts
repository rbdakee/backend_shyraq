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
    const count = await this.redis.incr(key);
    if (count === 1) {
      await this.redis.expire(key, windowSec);
    }
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
