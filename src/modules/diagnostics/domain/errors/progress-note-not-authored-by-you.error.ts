import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — non-admin mentor attempted to update or delete a progress_note
 * authored by a different mentor. Admins bypass this check at the service
 * layer.
 */
export class ProgressNoteNotAuthoredByYouError extends ForbiddenActionError {
  public readonly code = 'progress_note_not_authored_by_you' as const;

  constructor() {
    super(
      'progress_note_not_authored_by_you',
      'progress note is not authored by the calling mentor',
    );
  }
}
