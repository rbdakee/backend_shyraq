import { InvariantViolationError } from '@/shared-kernel/domain/errors';

export type CustomDiscountConditionsInvalidReason =
  | 'unknown_condition_type'
  | 'invalid_condition_field'
  | 'conditions_depth_limit_exceeded'
  /** B22b T7 M10: per-composite branch count cap (`MAX_WIDTH`). */
  | 'conditions_width_limit_exceeded'
  | 'invalid_date_format'
  | 'invalid_root_shape';

/**
 * 400 — the `conditions` JSONB on a CustomDiscount row failed schema
 * validation (during entity hydration, or when a caller supplied a malformed
 * patch). `reason` is a machine-readable slug so clients can branch.
 *
 * Maps to BAD_REQUEST via DomainErrorFilter (InvariantViolationError → 400).
 */
export class CustomDiscountConditionsInvalidError extends InvariantViolationError {
  public readonly details: {
    reason: CustomDiscountConditionsInvalidReason;
    path?: string;
  };

  constructor(reason: CustomDiscountConditionsInvalidReason, path?: string) {
    super('custom_discount_conditions_invalid');
    this.details = path === undefined ? { reason } : { reason, path };
  }
}
