import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — state-machine guard violation: the caller asked the Payment
 * aggregate to perform a transition (`markProcessing`, `markCompleted`,
 * `markFailed`, `markRefunded`) that is not legal from its current
 * status.
 */
export class PaymentStatusInvalidError extends ConflictError {
  public readonly code = 'payment_status_invalid' as const;
  public readonly details: {
    currentStatus: string;
    attemptedAction: string;
  };

  constructor(currentStatus: string, attemptedAction: string) {
    super(
      'payment_status_invalid',
      `payment status invalid: action=${attemptedAction} got=${currentStatus}`,
    );
    this.details = { currentStatus, attemptedAction };
  }
}
