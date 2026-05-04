import { ConflictError } from '@/shared-kernel/domain/errors';
import { ActivityEventStatusValue } from '../value-objects/activity-event-status.vo';

/**
 * Lost-update race on activity_event status transition.
 *
 * Surfaced when a conditional UPDATE (`WHERE status = <expected_old>`) affects
 * 0 rows: another concurrent request already moved the event to a different
 * status between our read-validate and our write. The current request loses
 * the race; the response is HTTP 409 so the client can re-fetch + retry.
 *
 *   Read       : status = scheduled
 *   Domain ok  : scheduled → in_progress (start) AND scheduled → cancelled (cancel)
 *   Write start: UPDATE … WHERE status = 'scheduled' → 1 row affected (winner)
 *   Write cancel: UPDATE … WHERE status = 'scheduled' → 0 rows affected (loser → 409)
 */
export class EventTransitionConflictError extends ConflictError {
  public readonly code = 'event_transition_conflict' as const;

  constructor(
    public readonly eventId: string,
    public readonly expectedFrom: ActivityEventStatusValue,
    public readonly attemptedTo: ActivityEventStatusValue,
  ) {
    super(
      'event_transition_conflict',
      `activity_event ${eventId} status changed concurrently: expected ${expectedFrom} when transitioning to ${attemptedTo}`,
    );
  }
}
