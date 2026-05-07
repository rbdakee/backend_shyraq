import { InvariantViolationError } from '@/shared-kernel/domain/errors';

export type CustomDiscountTargetInvalidReason =
  | 'target_ids_required'
  | 'target_ids_must_be_empty'
  | 'unknown_target_type';

/**
 * 400 — invalid target shape on a CustomDiscount row:
 *   - target_type='all' but target_ids is a non-empty array, or
 *   - target_type ∈ {children, groups, tariff_types} but target_ids is
 *     null / empty, or
 *   - target_type is not one of the known values.
 *
 * Maps to BAD_REQUEST via DomainErrorFilter (InvariantViolationError → 400).
 */
export class CustomDiscountTargetInvalidError extends InvariantViolationError {
  public readonly details: {
    targetType: string;
    reason: CustomDiscountTargetInvalidReason;
  };

  constructor(targetType: string, reason: CustomDiscountTargetInvalidReason) {
    super('custom_discount_target_invalid');
    this.details = { targetType, reason };
  }
}
