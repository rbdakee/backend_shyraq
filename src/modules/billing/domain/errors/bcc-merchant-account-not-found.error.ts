import { NotFoundError } from '@/shared-kernel/domain/errors';

export class BccMerchantAccountNotFoundError extends NotFoundError {
  public readonly code = 'bcc_account_not_found' as const;

  constructor(kindergartenId: string) {
    super(
      'bcc_account_not_found',
      `BCC merchant account not found for kindergarten ${kindergartenId}`,
    );
  }
}
