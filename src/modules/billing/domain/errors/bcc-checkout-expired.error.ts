import { GoneError } from '@/shared-kernel/domain/errors';

export class BccCheckoutExpiredError extends GoneError {
  public readonly code = 'bcc_checkout_expired' as const;

  constructor() {
    super(
      'bcc_checkout_expired',
      'BCC checkout session expired or was already consumed',
    );
  }
}
