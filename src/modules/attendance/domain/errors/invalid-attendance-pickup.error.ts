import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * 422 — semantic validation error for the pickup payload itself (separate
 * from `pickup_user_not_allowed`, which is a permission problem). Examples:
 *   - PATCH attempted to add a `pickupUserId` to a check-in event.
 *   - check-out called without `pickupUserId`.
 *
 * Maps to HTTP 422 via the generic `DomainError → UNPROCESSABLE_ENTITY`
 * fallback in `DomainErrorFilter`.
 */
export class InvalidAttendancePickupError extends DomainError {
  constructor(message: string) {
    super('invalid_attendance_pickup', message);
  }
}
