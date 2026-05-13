import {
  TariffAssignment,
  TariffAssignmentState,
} from '../../../../domain/entities/tariff-assignment.entity';
import { TariffAssignmentTypeOrmEntity } from '../entities/tariff-assignment.typeorm.entity';
import { toDate, toDateOrNull } from './date-utils';

export class TariffAssignmentMapper {
  static toDomain(row: TariffAssignmentTypeOrmEntity): TariffAssignment {
    const state: TariffAssignmentState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      childId: row.childId,
      tariffPlanId: row.tariffPlanId,
      // Transformer hands `MoneyKzt` directly — pass through.
      customAmount: row.customAmount,
      customReason: row.customReason,
      validFrom: toDate(row.validFrom),
      validUntil: toDateOrNull(row.validUntil),
      assignedBy: row.assignedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return TariffAssignment.fromState(state);
  }
}
