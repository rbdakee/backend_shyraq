import { TooManyRequestsError } from '@/shared-kernel/domain/errors';

/**
 * Thrown when the per-email SuperAdmin login rate-limit (10/hour) is
 * exceeded. Maps to HTTP 429. Code is `saas_login_rate_limit`.
 */
export class SaasLoginRateLimitError extends TooManyRequestsError {
  constructor() {
    super('saas_login_rate_limit');
  }
}
