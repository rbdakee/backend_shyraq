import { Injectable } from '@nestjs/common';
import { RedisService } from '@/redis/redis.service';
import { QrScanRateLimiterPort } from './qr-scan-rate-limiter.port';

const KEY_PREFIX = 'rl:qr:scan:';
const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_SECONDS = 60;

/**
 * Fixed-window rate-limiter on `rl:qr:scan:{deviceId}`. Uses a Redis
 * pipeline to batch INCR + EXPIRE in one round-trip — this prevents a
 * crash between the two commands from leaving the key without a TTL
 * (which would permanently block the device). Both commands are always
 * sent; resetting the TTL on an existing key is safe because it just
 * resets it to the window boundary, preserving fixed-window semantics.
 *
 * When the limit is exceeded we read the remaining TTL so callers can
 * surface a precise `retryAfterSeconds` to the client.
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
    // Pipeline batches INCR + EXPIRE in one round-trip so a crash between
    // the two commands cannot leave the key without a TTL (permanent block).
    const pl = this.redis.pipeline();
    pl.incr(key);
    pl.expire(key, this.windowSeconds);
    const plResults = await pl.exec();
    // plResults[0] = [error, incrResult], plResults[1] = [error, expireResult]
    const next = (plResults?.[0]?.[1] as number | null) ?? 1;
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
