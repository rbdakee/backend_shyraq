import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { QrTokenCachePort } from './qr-token-cache.port';

const KEY_PREFIX = 'qr:token:';

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
    await this.redis.set(this.key(plaintext), userId, 'EX', ttlSeconds);
  }

  async lookup(plaintext: string): Promise<string | null> {
    return this.redis.get(this.key(plaintext));
  }

  async revoke(plaintext: string): Promise<void> {
    await this.redis.del(this.key(plaintext));
  }

  private key(plaintext: string): string {
    return `${KEY_PREFIX}${plaintext}`;
  }
}
