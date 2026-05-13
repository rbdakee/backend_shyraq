import {
  TariffPlan,
  TariffPlanState,
} from '../../../../domain/entities/tariff-plan.entity';
import { TariffPlanTypeOrmEntity } from '../entities/tariff-plan.typeorm.entity';
import { toDate, toDateOrNull } from './date-utils';

export class TariffPlanMapper {
  static toDomain(row: TariffPlanTypeOrmEntity): TariffPlan {
    const state: TariffPlanState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      name: row.name,
      description: row.description ?? {},
      tariffType: row.tariffType,
      // Transformer hands `MoneyKzt` directly — pass through.
      amount: row.amount,
      currency: row.currency,
      appliesTo: row.appliesTo,
      groupId: row.groupId,
      ageMinMonths: row.ageMinMonths,
      ageMaxMonths: row.ageMaxMonths,
      isActive: row.isActive,
      validFrom: toDate(row.validFrom),
      validUntil: toDateOrNull(row.validUntil),
      discountRules: row.discountRules ?? {},
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return TariffPlan.fromState(state);
  }
}
