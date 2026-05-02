import { TooManyRequestsError } from '@/shared-kernel/domain/errors';

/**
 * 429 — a staff device exceeded the per-device QR-scan rate (60 / 60s).
 * `details.retryAfterSeconds` is passed verbatim by `DomainErrorFilter` so
 * the client can back off precisely.
 */
export class QrScanRateLimitExceededError extends TooManyRequestsError {
  public readonly code = 'qr_rate_limit_exceeded' as const;
  public readonly details: { retryAfterSeconds: number };

  constructor(retryAfterSeconds: number) {
    super('qr_rate_limit_exceeded', 'qr scan rate limit exceeded');
    this.details = { retryAfterSeconds };
  }
}
