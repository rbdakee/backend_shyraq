import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — `valid_until` on a CustomDiscount is non-null but not strictly
 * greater than `valid_from`. Mirrors the DB-level check constraint
 * `chk_custom_discounts_validity`.
 */
export class CustomDiscountValidityInvalidError extends InvariantViolationError {
  public readonly details: {
    validFrom: string;
    validUntil: string;
  };

  constructor(validFrom: Date, validUntil: Date) {
    super('custom_discount_validity_invalid');
    this.details = {
      validFrom: validFrom.toISOString(),
      validUntil: validUntil.toISOString(),
    };
  }
}
