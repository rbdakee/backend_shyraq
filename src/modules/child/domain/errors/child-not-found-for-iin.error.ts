import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * Cross-tenant IIN lookup returned zero matches. The user attempted to link a
 * child by a national-ID (IIN) that does not exist in any kindergarten yet —
 * either the admin hasn't enrolled the child, or the IIN was mistyped.
 * Mapped to HTTP 404.
 *
 * Overrides the base `not_found` code with a module-specific one so the
 * frontend can disambiguate "child by id missing" vs "child by iin missing"
 * without parsing the message.
 */
export class ChildNotFoundForIinError extends NotFoundError {
  constructor(public readonly iin: string) {
    super('child', `iin=${iin}`);
    // Re-tag the code on this instance so DomainErrorFilter emits a
    // module-specific code in the response body (the base class set it to
    // `not_found`).
    (this as { code: string }).code = 'child_not_found_for_iin';
  }
}
