import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — admin tried to create a holiday on a date already covered by an
 * existing entry for the same kindergarten. Maps the
 * `uq_kindergarten_holidays_kg_date` UNIQUE constraint violation.
 */
export class KindergartenHolidayAlreadyExistsError extends ConflictError {
  public readonly code = 'kindergarten_holiday_already_exists' as const;
  public readonly details: { kindergartenId: string; date: string };

  constructor(kindergartenId: string, date: string) {
    super(
      'kindergarten_holiday_already_exists',
      `kindergarten holiday already exists for kg=${kindergartenId} date=${date}`,
    );
    this.details = { kindergartenId, date };
  }
}
