import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller looked up a payment_account by id (or by `(kg, child)` pair)
 * that is not visible under the caller's tenant scope or has not been
 * created yet. Service code typically auto-creates accounts on first
 * invoice generation, so this surfaces only on misuse.
 */
export class PaymentAccountNotFoundError extends NotFoundError {
  public readonly code = 'payment_account_not_found' as const;

  constructor(key: string) {
    super('payment_account', key);
  }
}
