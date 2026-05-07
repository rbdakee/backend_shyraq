import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — non-admin specialist attempted to update or delete a
 * diagnostic_entry authored by a different specialist. Admins bypass this
 * check at the service layer.
 */
export class DiagnosticEntryNotAuthoredByYouError extends ForbiddenActionError {
  public readonly code = 'diagnostic_entry_not_authored_by_you' as const;

  constructor() {
    super(
      'diagnostic_entry_not_authored_by_you',
      'diagnostic entry is not authored by the calling specialist',
    );
  }
}
