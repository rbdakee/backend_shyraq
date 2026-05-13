import { TariffAssignment } from './domain/entities/tariff-assignment.entity';
import { TariffAssignmentResponseDto } from './dto/tariff-assignment.dto';

/**
 * Domain → response-DTO mapper for TariffAssignment.
 * Pure (no Nest / TypeORM imports).
 */
export const TariffAssignmentPresenter = {
  one(assignment: TariffAssignment): TariffAssignmentResponseDto {
    const s = assignment.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      child_id: s.childId,
      tariff_plan_id: s.tariffPlanId,
      custom_amount: s.customAmount === null ? null : s.customAmount.toNumber(),
      custom_reason: s.customReason,
      valid_from: toIsoDate(s.validFrom),
      valid_until: s.validUntil ? toIsoDate(s.validUntil) : null,
      assigned_by: s.assignedBy,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  many(assignments: TariffAssignment[]): TariffAssignmentResponseDto[] {
    return assignments.map((a) => TariffAssignmentPresenter.one(a));
  },
};

function toIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
