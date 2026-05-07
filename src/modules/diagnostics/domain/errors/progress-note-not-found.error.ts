import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a progress_note id that is not visible under
 * the caller's tenant scope (or simply does not exist).
 */
export class ProgressNoteNotFoundError extends NotFoundError {
  public readonly code = 'progress_note_not_found' as const;

  constructor(noteId: string) {
    super('progress_note', noteId);
  }
}
