import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404-mapped error: the enrollment row does not exist (or RLS hides it from the
 * caller's tenant). The `code` is module-specific (`enrollment_not_found`) so
 * the API client can disambiguate from generic `not_found`.
 *
 * Extending `NotFoundError` makes `DomainErrorFilter` map this to HTTP 404
 * via its existing `instanceof NotFoundError` branch.
 */
export class EnrollmentNotFoundError extends NotFoundError {
  public readonly code = 'enrollment_not_found' as const;

  constructor(public readonly enrollmentId: string) {
    super('enrollment', enrollmentId);
  }
}
