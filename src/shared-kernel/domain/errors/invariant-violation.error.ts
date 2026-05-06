import { DomainError } from './domain.error';

/**
 * Thrown when a domain invariant is violated. The `code` is the caller-supplied
 * slug (e.g. `parent_request_weekend_date_not_weekend`) so the HTTP response
 * body surfaces a specific, actionable error key rather than the generic
 * `invariant_violation` label. Callers that do not need a specific code may
 * still pass a descriptive string; the old generic name is preserved as a
 * fallback when the caller passes an empty string.
 */
export class InvariantViolationError extends DomainError {
  constructor(code: string) {
    super(code || 'invariant_violation', code || 'invariant_violation');
  }
}
