import { DomainError } from './domain.error';

/**
 * Base class for domain errors that map to HTTP 410 Gone — the resource
 * existed but is no longer available (e.g. a QR token that has expired or
 * been revoked). The 410 status differs from 404 in that it asserts the
 * resource is *known* to be gone, so the client should not retry the same
 * identifier.
 *
 * Subclasses override `code` with a module-specific string
 * (e.g. `qr_token_expired`) so API clients can disambiguate.
 */
export class GoneError extends DomainError {
  constructor(code: string, message?: string) {
    super(code, message);
  }
}
