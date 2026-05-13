import {
  CustomDiscount,
  CustomDiscountState,
  CustomDiscountTargetType,
} from '../../../../domain/entities/custom-discount.entity';
import {
  ConditionsRoot,
  validateConditionsSchema,
} from '../../../../domain/discount-conditions/conditions-evaluator';
import { CustomDiscountTypeOrmEntity } from '../entities/custom-discount.typeorm.entity';

/**
 * Maps `custom_discounts` rows ↔ `CustomDiscount` aggregate.
 *
 * Hydration runs `validateConditionsSchema` once via the aggregate ctor
 * (T2) — the mapper just hands the raw JSONB through. PG `numeric(10,2)`
 * is read as `number` by the column transformer; nothing else needs
 * normalising.
 */
export class CustomDiscountMapper {
  static toDomain(row: CustomDiscountTypeOrmEntity): CustomDiscount {
    const conditions = validateConditionsSchema(
      row.conditions as unknown,
    ) as ConditionsRoot;
    const state: CustomDiscountState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      name: row.name as Record<string, string>,
      description: row.description as Record<string, string> | null,
      discountType: row.discountType,
      // Transformer hands `MoneyKzt` directly — pass through.
      amount: row.amount,
      conditions,
      targetType: row.targetType as CustomDiscountTargetType,
      targetIds: row.targetIds,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      maxUsesPerChild: row.maxUsesPerChild,
      totalMaxUses: row.totalMaxUses,
      usedCount: row.usedCount,
      priority: row.priority,
      stackable: row.stackable,
      notifyOnActivation: row.notifyOnActivation,
      notificationTitle: row.notificationTitle as Record<string, string> | null,
      notificationBody: row.notificationBody as Record<string, string> | null,
      status: row.status,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return CustomDiscount.fromState(state);
  }
}
