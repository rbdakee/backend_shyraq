import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { RedisKeys } from '@/redis/redis-keys';
import { TokenBlocklistPort } from '../../token-blocklist.port';

@Injectable()
export class RedisTokenBlocklistAdapter extends TokenBlocklistPort {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async isBlocked(jti: string): Promise<boolean> {
    const v = await this.redis.get(RedisKeys.tokenBlocklist(jti));
    return v !== null;
  }

  async blocklist(jti: string, expUnix: number): Promise<void> {
    const ttl = Math.max(1, expUnix - Math.floor(Date.now() / 1000));
    await this.redis.set(RedisKeys.tokenBlocklist(jti), '1', 'EX', ttl);
  }
}
