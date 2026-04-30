import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — partial-unique violation on (template_id, day_of_week, start_time).
 * Two slots within the same template cannot share the same day + start time.
 */
export class SlotConflictError extends ConflictError {
  constructor(
    public readonly templateId: string,
    public readonly dayOfWeek: string,
    public readonly startTime: string,
  ) {
    super(
      'slot_time_conflict',
      `slot already exists at template=${templateId} day=${dayOfWeek} start=${startTime}`,
    );
  }
}
