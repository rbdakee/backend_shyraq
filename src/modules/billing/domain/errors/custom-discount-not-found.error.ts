import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a custom_discounts row that is not visible under
 * the caller's tenant scope (or simply does not exist).
 */
export class CustomDiscountNotFoundError extends NotFoundError {
  public readonly code = 'custom_discount_not_found' as const;

  constructor(customDiscountId: string) {
    super('custom_discount', customDiscountId);
  }
}
