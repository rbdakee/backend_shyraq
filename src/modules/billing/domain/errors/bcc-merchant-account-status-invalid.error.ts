import { ConflictError } from '@/shared-kernel/domain/errors';

export class BccMerchantAccountStatusInvalidError extends ConflictError {
  public readonly code = 'bcc_merchant_account_status_invalid' as const;
  public readonly details: {
    currentStatus: string;
    attemptedAction: string;
  };

  constructor(currentStatus: string, attemptedAction: string) {
    super(
      'bcc_merchant_account_status_invalid',
      `BCC merchant account status invalid: action=${attemptedAction} got=${currentStatus}`,
    );
    this.details = { currentStatus, attemptedAction };
  }
}
