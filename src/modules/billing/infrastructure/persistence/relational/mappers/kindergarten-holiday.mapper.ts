import {
  KindergartenHoliday,
  KindergartenHolidayState,
} from '../../../../domain/entities/kindergarten-holiday.entity';
import { KindergartenHolidayTypeOrmEntity } from '../entities/kindergarten-holiday.typeorm.entity';
import { toDate } from './date-utils';

export class KindergartenHolidayMapper {
  static toDomain(row: KindergartenHolidayTypeOrmEntity): KindergartenHoliday {
    const state: KindergartenHolidayState = {
      id: row.id,
      kindergartenId: row.kindergartenId,
      date: toDate(row.date),
      name: row.name,
      isBillable: row.isBillable,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    return KindergartenHoliday.fromState(state);
  }
}
