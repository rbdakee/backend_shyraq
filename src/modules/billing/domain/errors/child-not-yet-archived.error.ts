import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Pro-rata refund worker race: the BullMQ job was picked up before the
 * producer's archive transaction committed in PostgreSQL. The processor
 * re-reads the child and observes a non-archived status, so we throw this
 * retryable error to let BullMQ retry under exp-backoff — by the next
 * attempt the producer TX is almost certainly committed.
 *
 * Distinct from `child_not_archived` skip (which is a *permanent* skip for
 * cases where the producer TX actually rolled back). The grace window
 * (60 seconds since `archivedAt`) governs which branch wins.
 *
 * The error is intentionally not mapped in `DomainErrorFilter`: it surfaces
 * only inside the BullMQ worker and is consumed by BullMQ's retry machinery.
 */
export class ChildNotYetArchivedError extends DomainError {
  constructor(
    public readonly childId: string,
    public readonly observedStatus: string,
  ) {
    super(
      'child_not_yet_archived',
      `child ${childId} not yet archived (observed=${observedStatus}); retry pending commit`,
    );
  }
}
