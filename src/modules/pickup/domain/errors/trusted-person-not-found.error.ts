import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — a trusted_people row id from the request body did not resolve to any
 * row visible under the caller's tenant scope (RLS-filtered by
 * `kindergarten_id`). The `code` is module-specific so API clients can
 * disambiguate from generic `not_found`.
 */
export class TrustedPersonNotFoundError extends NotFoundError {
  public readonly code = 'trusted_person_not_found' as const;

  constructor(trustedPersonId: string) {
    super('trusted_person', trustedPersonId);
  }
}
