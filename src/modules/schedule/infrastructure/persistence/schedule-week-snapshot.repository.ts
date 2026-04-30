import { ScheduleWeekSnapshot } from '../../domain/entities/schedule-week-snapshot.entity';

export interface ListScheduleWeekSnapshotsFilter {
  groupId?: string;
  from?: Date;
  to?: Date;
}

/**
 * Port over `schedule_week_snapshots`. `findByGroupAndWeek` is the
 * idempotency probe used by `copyWeekToNext` before doing any work for a
 * group.
 */
export abstract class ScheduleWeekSnapshotRepository {
  abstract create(
    kindergartenId: string,
    snapshot: ScheduleWeekSnapshot,
  ): Promise<ScheduleWeekSnapshot>;

  abstract findByGroupAndWeek(
    kindergartenId: string,
    groupId: string,
    weekStartDate: Date,
  ): Promise<ScheduleWeekSnapshot | null>;

  abstract list(
    kindergartenId: string,
    filter: ListScheduleWeekSnapshotsFilter,
  ): Promise<ScheduleWeekSnapshot[]>;
}
