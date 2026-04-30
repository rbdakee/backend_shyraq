import { DomainError } from './domain.error';

/**
 * Base class for domain errors that represent an action the caller is not
 * permitted to perform on a resource (HTTP 403). Examples: a primary guardian
 * trying to self-unlink, a non-primary trying to approve another guardian.
 *
 * Distinct from authentication failures (401) and from conflict errors (409,
 * `ConflictError`) which represent state mismatches rather than permission
 * denials.
 *
 * Subclasses are expected to override `code` with a module-specific string
 * (e.g. `primary_cannot_self_unlink`) so API clients can disambiguate.
 */
export class ForbiddenActionError extends DomainError {
  constructor(code: string, message?: string) {
    super(code, message);
  }
}
