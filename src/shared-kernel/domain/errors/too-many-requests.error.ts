import { DomainError } from './domain.error';

/**
 * Base class for domain errors that map to HTTP 429 Too Many Requests —
 * the caller has been throttled. Subclasses can attach a `details` object
 * (the `DomainErrorFilter` passes it through verbatim) to return
 * `retryAfterSeconds` or similar back-off hints to the client.
 *
 * Subclasses override `code` with a module-specific string (e.g.
 * `qr_rate_limit_exceeded`).
 */
export class TooManyRequestsError extends DomainError {
  constructor(code: string, message?: string) {
    super(code, message);
  }
}
