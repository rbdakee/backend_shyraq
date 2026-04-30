import { ChildDailyStatus } from '../../../../domain/entities/child-daily-status.entity';
import { ChildDailyStatusTypeOrmEntity } from '../entities/child-daily-status.typeorm.entity';

/**
 * `date` is stored as PostgreSQL `date` (no timezone). The PG driver returns
 * it as a string `YYYY-MM-DD`. We pass it through unchanged into the domain
 * entity, which keeps the ISO date string as its identifier across the
 * domain layer (no Date object, no TZ ambiguity).
 */
export class ChildDailyStatusMapper {
  static toDomain(row: ChildDailyStatusTypeOrmEntity): ChildDailyStatus {
    return ChildDailyStatus.hydrate({
      id: row.id,
      kindergartenId: row.kindergarten_id,
      childId: row.child_id,
      date: typeof row.date === 'string' ? row.date : toIsoDate(row.date),
      status: row.status,
      note: row.note,
      setBy: row.set_by,
      updatedAt:
        row.updated_at instanceof Date
          ? row.updated_at
          : new Date(row.updated_at),
    });
  }
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
