import { TariffPlan } from './domain/entities/tariff-plan.entity';
import { TariffPlanResponseDto } from './dto/tariff-plan.dto';

/**
 * Domain → response-DTO mapper for TariffPlan.
 * Pure (no Nest / TypeORM imports) — safe to use in service unit specs.
 */
export const TariffPlanPresenter = {
  one(plan: TariffPlan): TariffPlanResponseDto {
    const s = plan.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      name: s.name,
      description: s.description,
      tariff_type: s.tariffType,
      amount: s.amount,
      currency: s.currency,
      applies_to: s.appliesTo,
      group_id: s.groupId,
      age_min_months: s.ageMinMonths,
      age_max_months: s.ageMaxMonths,
      is_active: s.isActive,
      valid_from: toIsoDate(s.validFrom),
      valid_until: s.validUntil ? toIsoDate(s.validUntil) : null,
      discount_rules: s.discountRules,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  many(plans: TariffPlan[]): TariffPlanResponseDto[] {
    return plans.map((p) => TariffPlanPresenter.one(p));
  },
};

function toIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
