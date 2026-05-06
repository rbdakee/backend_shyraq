import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — caller asked to transition a refund that is already in a terminal
 * (`processed`, `rejected`) or non-pending state. Mirrors the
 * `parent-request-already-processed` pattern.
 */
export class RefundAlreadyProcessedError extends ConflictError {
  public readonly code = 'refund_already_processed' as const;
  public readonly details: {
    currentStatus: string;
    attemptedAction: string;
  };

  constructor(currentStatus: string, attemptedAction: string) {
    super(
      'refund_already_processed',
      `refund already processed: action=${attemptedAction} got=${currentStatus}`,
    );
    this.details = { currentStatus, attemptedAction };
  }
}
