import { TooManyRequestsError } from '@/shared-kernel/domain/errors';

/**
 * Thrown when an authenticated parent caller exceeds the per-user rate-limit
 * on `POST /parent/children/link` (default 5 attempts / hour). The endpoint
 * does an authenticated cross-tenant IIN probe — without throttling, any
 * caller with a valid JWT could enumerate IINs platform-wide. Maps to HTTP
 * 429. Code is `parent_link_rate_limit`.
 */
export class ParentLinkRateLimitError extends TooManyRequestsError {
  constructor() {
    super('parent_link_rate_limit');
  }
}
