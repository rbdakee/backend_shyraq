import { EntityManager } from 'typeorm';
import { CustomDiscountApplication } from './domain/entities/custom-discount-application.entity';
import { CustomDiscountPageRequest } from './custom-discount.repository';

export interface CreateCustomDiscountApplicationInput {
  kindergartenId: string;
  customDiscountId: string;
  invoiceId: string;
  invoiceLineItemId: string | null;
  childId: string;
  amountApplied: number;
}

export interface CustomDiscountApplicationStats {
  count: number;
  totalAmountApplied: number;
}

/**
 * Persistence port for `custom_discount_applications` (B16). Insert-only
 * ledger — no update / delete surface. Reads support per-discount stats
 * + paginated listing for the admin detail view.
 */
export abstract class CustomDiscountApplicationRepository {
  abstract create(
    input: CreateCustomDiscountApplicationInput,
    manager?: EntityManager,
  ): Promise<CustomDiscountApplication>;

  /**
   * Counts how many applications already exist for the (child, discount)
   * pair. Used by `InvoiceService` to enforce `max_uses_per_child`
   * before passing the discount to the engine.
   */
  abstract countByChildAndDiscount(
    kindergartenId: string,
    childId: string,
    customDiscountId: string,
    manager?: EntityManager,
  ): Promise<number>;

  abstract listByDiscountId(
    kindergartenId: string,
    customDiscountId: string,
    pagination: CustomDiscountPageRequest,
  ): Promise<{ rows: CustomDiscountApplication[]; total: number }>;

  /**
   * Aggregates `count` + `SUM(amount_applied)` for the discount. Used in
   * `GET /admin/custom-discounts/:id` response.
   */
  abstract getStatsForDiscount(
    kindergartenId: string,
    customDiscountId: string,
  ): Promise<CustomDiscountApplicationStats>;
}
