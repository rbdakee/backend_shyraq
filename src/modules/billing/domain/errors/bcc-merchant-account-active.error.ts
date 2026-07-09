import { ConflictError } from '@/shared-kernel/domain/errors';

export class BccMerchantAccountActiveError extends ConflictError {
  public readonly code = 'bcc_account_active' as const;

  constructor() {
    super(
      'bcc_account_active',
      'Active BCC account must use the dedicated rotation endpoints',
    );
  }
}
