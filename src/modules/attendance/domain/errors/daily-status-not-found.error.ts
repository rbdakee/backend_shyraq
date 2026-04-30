import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — child_daily_status row does not exist for the requested
 * (child, date) tuple. Currently used by T4 read endpoints; the upsert
 * path inside AttendanceService never throws it.
 */
export class DailyStatusNotFoundError extends NotFoundError {
  public readonly code = 'daily_status_not_found' as const;

  constructor(
    public readonly childId: string,
    public readonly date: string,
  ) {
    super('child_daily_status', `${childId}@${date}`);
  }
}
