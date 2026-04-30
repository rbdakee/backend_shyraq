import { ConflictError } from '@/shared-kernel/domain/errors';
import { ActivityEventStatusValue } from '../value-objects/activity-event-status.vo';

/**
 * Disallowed activity_event status edge.
 *
 *   scheduled    → in_progress | cancelled
 *   in_progress  → completed   | cancelled
 *   completed    → (terminal)
 *   cancelled    → (terminal)
 */
export class InvalidEventTransitionError extends ConflictError {
  constructor(
    public readonly from: ActivityEventStatusValue,
    public readonly to: ActivityEventStatusValue,
  ) {
    super(
      'invalid_activity_event_transition',
      `cannot transition activity_event status: ${from} -> ${to}`,
    );
  }
}
