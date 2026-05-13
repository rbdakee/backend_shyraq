import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Sentinel raised by `InvoiceService.generateAndPersistInvoice` when the
 * monthly-billing cron observes a child that flipped to `archived`
 * AFTER the run's initial active-assignment scan but BEFORE the
 * per-child INSERT TX could commit (FINDINGS B21-T6-M3 race).
 *
 * The race window is the per-child slice of `generateMonthly`'s loop:
 * we already short-circuit at the top of the loop on `child.status`,
 * but discount engine evaluation, custom-discount reservation, and
 * payment-account ensure all happen between that read and the INSERT.
 * The repo-level `existsActiveByIdForUpdate` guard ALSO acquires a
 * `FOR UPDATE` lock on the children row so the concurrent archive
 * UPDATE serialises behind our INSERT — the lock is released at TX
 * commit/rollback either way.
 *
 * Caught and logged by `generateMonthly`'s loop (counted as `skipped`
 * in the result, NOT propagated as a job failure). Not mapped by
 * `DomainErrorFilter`; intentionally invisible to HTTP clients.
 */
export class ChildArchivedDuringRunError extends DomainError {
  constructor(public readonly childId: string) {
    super(
      'child_archived_during_run',
      `child ${childId} archived between active scan and invoice INSERT — skipping monthly invoice`,
    );
  }
}
