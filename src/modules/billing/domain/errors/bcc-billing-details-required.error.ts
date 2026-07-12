import { InvariantViolationError } from '@/shared-kernel/domain/errors';

export class BccBillingDetailsRequiredError extends InvariantViolationError {
  public readonly code = 'bcc_billing_details_required' as const;

  constructor() {
    super('bcc_billing_details_required');
  }
}
