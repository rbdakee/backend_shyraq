import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a payment id that is not visible under the
 * caller's tenant scope (or simply does not exist).
 */
export class PaymentNotFoundError extends NotFoundError {
  public readonly code = 'payment_not_found' as const;

  constructor(paymentId: string) {
    super('payment', paymentId);
  }
}
