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

  /**
   * "Atomic claim" insert used by `copyWeekToNext` to take exclusive
   * ownership of `(group_id, week_start_date)` before writing any events.
   *
   * Returns the saved snapshot when the row was new, or `null` when a
   * conflicting row already exists (handled via `INSERT ... ON CONFLICT
   * DO NOTHING` so the call NEVER raises 23505 — keeping the ambient
   * transaction usable). This is what the service uses to avoid
   * orphan-event corruption when a concurrent caller wrote the snapshot
   * between our probe and our insert.
   */
  abstract tryCreate(
    kindergartenId: string,
    snapshot: ScheduleWeekSnapshot,
  ): Promise<ScheduleWeekSnapshot | null>;

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
