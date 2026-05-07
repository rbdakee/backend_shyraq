import { ConflictError } from '@/shared-kernel/domain/errors';

export type CustomDiscountMaxUsesLimitType = 'total' | 'per_child';

/**
 * 409 — a CustomDiscount can no longer be applied because it has reached
 * its global usage cap (`total_max_uses`) or the per-child cap
 * (`max_uses_per_child`). Service-layer pre-flight check throws this
 * before the apply transaction commits.
 */
export class CustomDiscountMaxUsesExceededError extends ConflictError {
  public readonly code = 'custom_discount_max_uses_exceeded' as const;
  public readonly details: {
    customDiscountId: string;
    limitType: CustomDiscountMaxUsesLimitType;
  };

  constructor(
    customDiscountId: string,
    limitType: CustomDiscountMaxUsesLimitType,
  ) {
    super(
      'custom_discount_max_uses_exceeded',
      `custom discount max uses exceeded: discount=${customDiscountId} limit=${limitType}`,
    );
    this.details = { customDiscountId, limitType };
  }
}
