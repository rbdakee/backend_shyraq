import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { QrTokenCachePort } from './qr-token-cache.port';

const TOKEN_KEY_PREFIX = 'qr:token:';
const USER_KEY_PREFIX = 'qr:user:';
const USER_KEY_SUFFIX = ':identity';

@Injectable()
export class RedisQrTokenCacheAdapter extends QrTokenCachePort {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async setToken(
    plaintext: string,
    userId: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(this.tokenKey(plaintext), userId, 'EX', ttlSeconds);
  }

  async lookup(plaintext: string): Promise<string | null> {
    return this.redis.get(this.tokenKey(plaintext));
  }

  async revoke(plaintext: string): Promise<void> {
    await this.redis.del(this.tokenKey(plaintext));
  }

  async setUserActiveToken(
    userId: string,
    plaintext: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.redis.set(this.userKey(userId), plaintext, 'EX', ttlSeconds);
  }

  async getUserActiveToken(userId: string): Promise<string | null> {
    return this.redis.get(this.userKey(userId));
  }

  async clearUserActiveToken(userId: string): Promise<void> {
    await this.redis.del(this.userKey(userId));
  }

  private tokenKey(plaintext: string): string {
    return `${TOKEN_KEY_PREFIX}${plaintext}`;
  }

  private userKey(userId: string): string {
    return `${USER_KEY_PREFIX}${userId}${USER_KEY_SUFFIX}`;
  }
}
