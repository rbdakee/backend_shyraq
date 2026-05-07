import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a diagnostic_entry id that is not visible under
 * the caller's tenant scope (or simply does not exist).
 */
export class DiagnosticEntryNotFoundError extends NotFoundError {
  public readonly code = 'diagnostic_entry_not_found' as const;

  constructor(entryId: string) {
    super('diagnostic_entry', entryId);
  }
}
