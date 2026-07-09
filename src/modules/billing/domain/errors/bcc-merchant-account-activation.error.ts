import { ConflictError } from '@/shared-kernel/domain/errors';

export class BccMerchantAccountActivationError extends ConflictError {
  public readonly code =
    'bcc_merchant_account_activation_requires_connection_check' as const;

  constructor() {
    super(
      'bcc_merchant_account_activation_requires_connection_check',
      'BCC merchant account activation requires a successful connection check',
    );
  }
}
