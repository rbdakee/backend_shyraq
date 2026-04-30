import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — partial-unique violation on (group_id, week_start_date) in
 * schedule_week_snapshots. Used by `copyWeekToNext` to signal idempotent skip
 * (the service catches and treats as no-op).
 */
export class WeekSnapshotAlreadyExistsError extends ConflictError {
  constructor(
    public readonly groupId: string,
    public readonly weekStartDate: string,
  ) {
    super(
      'week_snapshot_already_exists',
      `week snapshot already exists for group=${groupId} week=${weekStartDate}`,
    );
  }
}
