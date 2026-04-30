import { NotFoundError } from '@/shared-kernel/domain/errors';

export class ActivityEventNotFoundError extends NotFoundError {
  public readonly code = 'activity_event_not_found' as const;

  constructor(public readonly eventId: string) {
    super('activity_event', eventId);
  }
}
