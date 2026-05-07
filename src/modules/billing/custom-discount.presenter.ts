import { CustomDiscount } from './domain/entities/custom-discount.entity';
import { CustomDiscountApplication } from './domain/entities/custom-discount-application.entity';
import type { CustomDiscountApplicationStats } from './custom-discount-application.repository';
import {
  CustomDiscountApplicationListResponseDto,
  CustomDiscountApplicationResponseDto,
  CustomDiscountDetailResponseDto,
  CustomDiscountListResponseDto,
  CustomDiscountResponseDto,
} from './dto/custom-discount.dto';
import type {
  CustomDiscountWithStats,
  ListCustomDiscountsResult,
} from './custom-discount.service';

/**
 * Domain → response-DTO mapper for CustomDiscount and
 * CustomDiscountApplication. Pure (no NestJS / TypeORM imports).
 */
export const CustomDiscountPresenter = {
  one(discount: CustomDiscount): CustomDiscountResponseDto {
    const s = discount.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      name: s.name,
      description: s.description,
      discount_type: s.discountType,
      amount: s.amount,
      conditions: s.conditions,
      target_type: s.targetType,
      target_ids: s.targetIds,
      valid_from: toIsoDate(s.validFrom),
      valid_until: s.validUntil ? toIsoDate(s.validUntil) : null,
      max_uses_per_child: s.maxUsesPerChild,
      total_max_uses: s.totalMaxUses,
      used_count: s.usedCount,
      priority: s.priority,
      stackable: s.stackable,
      notify_on_activation: s.notifyOnActivation,
      notification_title: s.notificationTitle,
      notification_body: s.notificationBody,
      status: s.status,
      created_by: s.createdBy,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  detail(result: CustomDiscountWithStats): CustomDiscountDetailResponseDto {
    return {
      discount: CustomDiscountPresenter.one(result.discount),
      stats: {
        count: result.stats.count,
        total_amount_applied: result.stats.totalAmountApplied,
      },
    };
  },

  list(
    result: ListCustomDiscountsResult,
    page: number,
    limit: number,
  ): CustomDiscountListResponseDto {
    return {
      rows: result.rows.map((d) => CustomDiscountPresenter.one(d)),
      total: result.total,
      page,
      limit,
    };
  },

  application(
    app: CustomDiscountApplication,
  ): CustomDiscountApplicationResponseDto {
    const s = app.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      custom_discount_id: s.customDiscountId,
      invoice_id: s.invoiceId,
      invoice_line_item_id: s.invoiceLineItemId,
      child_id: s.childId,
      amount_applied: s.amountApplied,
      applied_at: s.appliedAt.toISOString(),
    };
  },

  applicationList(
    rows: CustomDiscountApplication[],
    total: number,
    page: number,
    limit: number,
  ): CustomDiscountApplicationListResponseDto {
    return {
      rows: rows.map((a) => CustomDiscountPresenter.application(a)),
      total,
      page,
      limit,
    };
  },
};

function toIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Re-export stats type for external use. */
export type { CustomDiscountApplicationStats };
