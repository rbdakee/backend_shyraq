import { DomainError } from './domain.error';

/**
 * Base class for domain errors that map to HTTP 422 Unprocessable Entity —
 * the request was syntactically valid but the server cannot process it
 * (semantic / business-rule violation that is *not* a state-machine
 * conflict (409) and *not* a malformed input (400)).
 *
 * Examples: payload bigger than business cap, schema-shape limit exceeded,
 * pre-condition for an action not met (`ArchiveReasonRequired` style).
 *
 * Subclasses are expected to override `code` with a module-specific slug
 * (e.g. `schema_too_large`) so API clients can disambiguate. The
 * `DomainErrorFilter` maps any subclass of this base to 422.
 */
export abstract class UnprocessableEntityError extends DomainError {
  readonly httpStatus = 422 as const;
}
