import { ConflictError } from '@/shared-kernel/domain/errors';
import { ActivityEventStatusValue } from '../value-objects/activity-event-status.vo';

/**
 * 409 — admin DELETE only allowed on `scheduled` events. Once an event has
 * started/finished/been cancelled it must remain in the audit trail.
 */
export class EventNotDeletableError extends ConflictError {
  constructor(public readonly status: ActivityEventStatusValue) {
    super(
      'activity_event_not_deletable',
      `activity_event in status ${status} cannot be deleted`,
    );
  }
}
