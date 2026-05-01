import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — the `notifications` row does not exist or RLS hides it from the
 * calling user.
 */
export class NotificationNotFoundError extends NotFoundError {
  public readonly code = 'notification_not_found' as const;

  constructor(public readonly notificationId: string) {
    super('notification', notificationId);
  }
}
