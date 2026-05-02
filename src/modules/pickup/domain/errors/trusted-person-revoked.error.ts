import { GoneError } from '@/shared-kernel/domain/errors';

/**
 * 410 Gone — the trusted_people row resolved but is no longer eligible to
 * back a pickup_request: it has been revoked (`revoked_at IS NOT NULL`),
 * deactivated, or already used as a one-time entry. Distinct from 404
 * because the row is *known* to exist — the client should pick a different
 * trusted person rather than retry the same id.
 */
export class TrustedPersonRevokedError extends GoneError {
  public readonly code = 'trusted_person_revoked' as const;

  constructor() {
    super(
      'trusted_person_revoked',
      'trusted person is no longer available for pickup',
    );
  }
}
