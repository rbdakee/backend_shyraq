import { InvariantViolationError } from '@/shared-kernel/domain/errors/invariant-violation.error';

/**
 * `Child.archive()` requires a human-readable reason between 1 and 500
 * characters (after trim). Thrown for empty / whitespace-only / overlong
 * strings. Mapped to HTTP 422 — the caller must supply a valid reason.
 */
export class ArchiveReasonRequiredError extends InvariantViolationError {
  constructor(public readonly childId: string) {
    super('archive_reason_required');
  }
}
