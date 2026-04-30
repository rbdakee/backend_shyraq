import {
  ScheduleWeekSnapshot,
  WeekSnapshotSource,
} from '../../../../domain/entities/schedule-week-snapshot.entity';
import { ScheduleWeekSnapshotEntity } from '../entities/schedule-week-snapshot.entity';

export class ScheduleWeekSnapshotMapper {
  static toDomain(row: ScheduleWeekSnapshotEntity): ScheduleWeekSnapshot {
    return ScheduleWeekSnapshot.hydrate({
      id: row.id,
      kindergartenId: row.kindergarten_id,
      groupId: row.group_id,
      weekStartDate:
        row.week_start_date instanceof Date
          ? row.week_start_date
          : new Date(row.week_start_date),
      source: row.source as WeekSnapshotSource,
      copiedFrom: row.copied_from,
      createdAt: row.created_at,
    });
  }
}
