import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — `amount` on a CustomDiscount (or `amount_applied` on a
 * CustomDiscountApplication) is not strictly positive. Mirrors the DB-level
 * check constraint `chk_custom_discounts_amount_positive` /
 * `chk_custom_discount_applications_amount_positive`.
 */
export class CustomDiscountAmountInvalidError extends InvariantViolationError {
  public readonly details: { amount: number };

  constructor(amount: number) {
    super('custom_discount_amount_invalid');
    this.details = { amount };
  }
}
