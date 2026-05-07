import { KindergartenHoliday } from './domain/entities/kindergarten-holiday.entity';
import { HolidayResponseDto } from './dto/holiday.dto';

/**
 * Domain → response-DTO mapper for KindergartenHoliday.
 * Pure (no Nest / TypeORM imports).
 */
export const HolidayPresenter = {
  one(holiday: KindergartenHoliday): HolidayResponseDto {
    const s = holiday.toState();
    return {
      id: s.id,
      kindergarten_id: s.kindergartenId,
      date: toIsoDate(s.date),
      name: s.name,
      is_billable: s.isBillable,
      created_at: s.createdAt.toISOString(),
      updated_at: s.updatedAt.toISOString(),
    };
  },

  many(holidays: KindergartenHoliday[]): HolidayResponseDto[] {
    return holidays.map((h) => HolidayPresenter.one(h));
  },
};

function toIsoDate(d: Date): string {
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
