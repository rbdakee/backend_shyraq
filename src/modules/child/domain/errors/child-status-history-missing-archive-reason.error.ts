import { InvariantViolationError } from '@/shared-kernel/domain/errors/invariant-violation.error';

/**
 * Thrown by `ChildStatusHistory.record(...)` when `new_status='archived'`
 * is requested without an `archive_reason`. Mirrors the DB CHECK
 * `chk_archive_reason_on_archive`. T13 M1 (opus) follow-up — was a raw
 * `Error` so the HTTP edge previously surfaced 500 instead of a typed
 * 422.
 */
export class ChildStatusHistoryMissingArchiveReasonError extends InvariantViolationError {
  constructor() {
    super('child_status_history_missing_archive_reason');
  }
}
