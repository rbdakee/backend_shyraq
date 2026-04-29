import { DomainError } from './domain.error';

/**
 * Base class for domain errors that represent a conflict with the current
 * state of a resource (HTTP 409). Examples: status-machine violations,
 * already-converted leads, locked-for-edit aggregates.
 *
 * Subclasses are expected to override `code` with a module-specific string
 * (e.g. `enrollment_locked`) so API clients can disambiguate.
 */
export class ConflictError extends DomainError {
  constructor(code: string, message?: string) {
    super(code, message);
  }
}
