import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { QrScanRateLimiterPort } from './qr-scan-rate-limiter.port';

const KEY_PREFIX = 'rl:qr:scan:';
const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_SECONDS = 60;

/**
 * Fixed-window rate-limiter on `rl:qr:scan:{deviceId}`. Uses Redis
 * `INCR` + `EXPIRE` — the same pattern as `RedisOtpStoreAdapter.checkRateLimit`.
 *
 * On the first call inside a window the key is created with TTL = window;
 * subsequent calls increment until the limit. When the limit is exceeded
 * we read the remaining TTL so callers can surface a precise
 * `retryAfterSeconds` to the client.
 */
@Injectable()
export class RedisQrScanRateLimiterAdapter extends QrScanRateLimiterPort {
  private readonly limit = DEFAULT_LIMIT;
  private readonly windowSeconds = DEFAULT_WINDOW_SECONDS;

  constructor(private readonly redis: RedisService) {
    super();
  }

  async check(
    deviceId: string,
  ): Promise<{ ok: boolean; retryAfterSeconds: number | null }> {
    const key = `${KEY_PREFIX}${deviceId}`;
    const next = await this.redis.incr(key);
    if (next === 1) {
      await this.redis.expire(key, this.windowSeconds);
    }
    if (next > this.limit) {
      const ttl = await this.redis.ttl(key);
      // `TTL` returns -1 if the key has no expiry, -2 if it has been
      // evicted between the INCR and the TTL read. In both cases we fall
      // back to the full window length — better to over-wait than to
      // signal an immediate retry.
      const retryAfter = ttl >= 0 ? ttl : this.windowSeconds;
      return { ok: false, retryAfterSeconds: retryAfter };
    }
    return { ok: true, retryAfterSeconds: null };
  }
}
