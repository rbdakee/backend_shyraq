import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — state-machine guard violation: the caller asked the Invoice
 * aggregate to perform a transition (`applyPayment`, `markOverdue`,
 * `cancel`, `applyRefund`) that is not legal from its current status.
 *
 * `currentStatus` / `attemptedAction` give clients enough context to
 * render an actionable message. Typed as `string` to avoid an entity ↔
 * errors import cycle.
 */
export class InvoiceStatusInvalidError extends ConflictError {
  public readonly code = 'invoice_status_invalid' as const;
  public readonly details: {
    currentStatus: string;
    attemptedAction: string;
  };

  constructor(currentStatus: string, attemptedAction: string) {
    super(
      'invoice_status_invalid',
      `invoice status invalid: action=${attemptedAction} got=${currentStatus}`,
    );
    this.details = { currentStatus, attemptedAction };
  }
}
