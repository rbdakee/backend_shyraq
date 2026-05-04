export interface StoredOtp {
  code: string;
  attempts: number;
}

export abstract class OtpStorePort {
  /**
   * Returns 'ok' if this request is within the hourly limit, 'exceeded' when it would break it.
   * Implementations must increment a counter on each call and set TTL on first bump.
   */
  abstract checkRateLimit(
    phone: string,
    maxPerWindow: number,
    windowSec: number,
  ): Promise<'ok' | 'exceeded'>;

  /**
   * Generic rate-limit check on an arbitrary Redis key. Same INCR+EXPIRE
   * semantics as checkRateLimit but accepts any key string — used for
   * non-OTP rate limits such as the SuperAdmin login throttle.
   */
  abstract checkRateLimitGeneric(
    key: string,
    maxPerWindow: number,
    windowSec: number,
  ): Promise<'ok' | 'exceeded'>;

  abstract isLocked(phone: string): Promise<boolean>;

  abstract storeCode(
    phone: string,
    code: string,
    ttlSec: number,
  ): Promise<void>;

  abstract readCode(phone: string): Promise<StoredOtp | null>;

  abstract incrementAttempts(phone: string): Promise<number>;

  abstract lockPhone(phone: string, ttlSec: number): Promise<void>;

  abstract clearCode(phone: string): Promise<void>;
}
