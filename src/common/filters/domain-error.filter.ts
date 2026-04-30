import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ConflictError,
  DomainError,
  ForbiddenActionError,
  InvariantViolationError,
  NotFoundError,
} from '@/shared-kernel/domain/errors';
import { IinAlreadyTakenError } from '@/modules/users/domain/errors/iin-already-taken.error';
import { ProfileUniqueViolationError } from '@/modules/users/domain/errors/profile-unique-violation.error';
import { InvalidCredentialsError } from '@/modules/auth/domain/errors/invalid-credentials.error';
import { NoActiveRolesError } from '@/modules/auth/domain/errors/no-active-roles.error';
import { OtpExpiredError } from '@/modules/auth/domain/errors/otp-expired.error';
import { OtpInvalidError } from '@/modules/auth/domain/errors/otp-invalid.error';
import { OtpLockedError } from '@/modules/auth/domain/errors/otp-locked.error';
import { OtpRateLimitedError } from '@/modules/auth/domain/errors/otp-rate-limited.error';
import { RefreshInvalidError } from '@/modules/auth/domain/errors/refresh-invalid.error';
import { RoleNotAvailableError } from '@/modules/auth/domain/errors/role-not-available.error';
import { FiscalSettingsForbiddenError } from '@/modules/kindergarten/domain/errors/fiscal-settings-forbidden.error';
import { KindergartenArchivedError } from '@/modules/kindergarten/domain/errors/kindergarten-archived.error';
import { KindergartenNotFoundError } from '@/modules/kindergarten/domain/errors/kindergarten-not-found.error';
import { KindergartenSlugTakenError } from '@/modules/kindergarten/domain/errors/kindergarten-slug-taken.error';
import { StaffAlreadyExistsError } from '@/modules/staff/domain/errors/staff-already-exists.error';
import { ChildAccessDeniedError } from '@/modules/child/domain/errors/child-access-denied.error';
import { ChildIinAlreadyExistsError } from '@/modules/child/domain/errors/child-iin-already-exists.error';
import { DuplicateGuardianError } from '@/modules/child/domain/errors/duplicate-guardian.error';
import { GroupTransferToSelfError } from '@/modules/child/domain/errors/group-transfer-to-self.error';
import { GuardianNotApprovedError } from '@/modules/child/domain/errors/guardian-not-approved.error';
import { InvalidChildProfileError } from '@/modules/child/domain/errors/invalid-child-profile.error';
import { InvalidChildStatusTransitionError } from '@/modules/child/domain/errors/invalid-child-status-transition.error';
import { InvalidGuardianStatusTransitionError } from '@/modules/child/domain/errors/invalid-guardian-status-transition.error';
import { MaxApprovalRightsExceededError } from '@/modules/child/domain/errors/max-approval-rights-exceeded.error';
import { NotPrimaryGuardianError } from '@/modules/child/domain/errors/not-primary-guardian.error';
import { MealPlanNotFoundError } from '@/modules/meal/domain/errors/meal-plan-not-found.error';
import { MealItemNotFoundError } from '@/modules/meal/domain/errors/meal-item-not-found.error';
import { MealPlanAlreadyExistsError } from '@/modules/meal/domain/errors/meal-plan-already-exists.error';
import { InvalidDateRangeError } from '@/modules/meal/domain/errors/invalid-date-range.error';
import { AttendanceEditWindowExpiredError } from '@/modules/attendance/domain/errors/attendance-edit-window-expired.error';
import { AttendanceEventNotFoundError } from '@/modules/attendance/domain/errors/attendance-event-not-found.error';
import { DailyStatusNotFoundError } from '@/modules/attendance/domain/errors/daily-status-not-found.error';
import { InvalidAttendancePickupError } from '@/modules/attendance/domain/errors/invalid-attendance-pickup.error';
import { InvalidAttendanceTimestampError } from '@/modules/attendance/domain/errors/invalid-attendance-timestamp.error';
import { InvalidTimelineEntryTypeError } from '@/modules/attendance/domain/errors/invalid-timeline-entry-type.error';
import { PickupUserNotAllowedError } from '@/modules/attendance/domain/errors/pickup-user-not-allowed.error';
import { TimelineEntryNotAuthorError } from '@/modules/attendance/domain/errors/timeline-entry-not-author.error';
import { TimelineEntryNotFoundError } from '@/modules/attendance/domain/errors/timeline-entry-not-found.error';

/**
 * Single source of truth for mapping AuthService / UsersService domain errors
 * to HTTP status codes. The errors carry stable string `code` values that the
 * frontend/clients match on — those codes are mirrored verbatim in the
 * response body so /docs and tests can rely on them.
 *
 * Note: the OTP errors extend `Error` (not DomainError) for legacy reasons;
 * they all expose a `code: string` property which we duck-type on.
 */
@Catch()
export class DomainErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    const status = this.statusFor(exception);
    if (status === null) {
      // Not a known domain error — let other filters / global handlers run.
      throw exception;
    }
    const code = (exception as { code?: string }).code ?? 'domain_error';
    const body: {
      statusCode: number;
      error: string;
      message: string;
      details?: Record<string, unknown>;
    } = { statusCode: status, error: code, message: code };
    const details =
      exception != null &&
      typeof exception === 'object' &&
      'details' in exception
        ? (exception as { details: unknown }).details
        : undefined;
    if (details != null && typeof details === 'object') {
      body.details = details as Record<string, unknown>;
    }
    res.status(status).json(body);
  }

  private statusFor(err: unknown): number | null {
    if (err instanceof OtpRateLimitedError) return HttpStatus.TOO_MANY_REQUESTS;
    if (err instanceof OtpLockedError) return HttpStatus.TOO_MANY_REQUESTS;
    if (err instanceof OtpExpiredError) return HttpStatus.BAD_REQUEST;
    if (err instanceof OtpInvalidError) return HttpStatus.BAD_REQUEST;
    if (err instanceof InvalidCredentialsError) return HttpStatus.UNAUTHORIZED;
    if (err instanceof RefreshInvalidError) return HttpStatus.UNAUTHORIZED;
    if (err instanceof RoleNotAvailableError) return HttpStatus.FORBIDDEN;
    if (err instanceof NoActiveRolesError) return HttpStatus.FORBIDDEN;
    if (err instanceof IinAlreadyTakenError) return HttpStatus.CONFLICT;
    if (err instanceof ProfileUniqueViolationError) return HttpStatus.CONFLICT;
    if (err instanceof KindergartenSlugTakenError) return HttpStatus.CONFLICT;
    if (err instanceof KindergartenArchivedError) return HttpStatus.CONFLICT;
    if (err instanceof StaffAlreadyExistsError) return HttpStatus.CONFLICT;
    if (err instanceof FiscalSettingsForbiddenError)
      return HttpStatus.FORBIDDEN;
    // Children & guardians
    if (err instanceof ChildAccessDeniedError) return HttpStatus.FORBIDDEN;
    if (err instanceof NotPrimaryGuardianError) return HttpStatus.FORBIDDEN;
    if (err instanceof ChildIinAlreadyExistsError) return HttpStatus.CONFLICT;
    if (err instanceof DuplicateGuardianError) return HttpStatus.CONFLICT;
    if (err instanceof MaxApprovalRightsExceededError)
      return HttpStatus.CONFLICT;
    if (err instanceof InvalidChildProfileError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (err instanceof InvalidChildStatusTransitionError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (err instanceof InvalidGuardianStatusTransitionError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (err instanceof GroupTransferToSelfError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (err instanceof GuardianNotApprovedError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    // Meal plans
    if (err instanceof MealPlanAlreadyExistsError) return HttpStatus.CONFLICT;
    if (err instanceof MealPlanNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof MealItemNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof InvalidDateRangeError) return HttpStatus.BAD_REQUEST;
    // B8 Attendance & Timeline
    if (err instanceof AttendanceEventNotFoundError)
      return HttpStatus.NOT_FOUND;
    if (err instanceof TimelineEntryNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof DailyStatusNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof AttendanceEditWindowExpiredError)
      return HttpStatus.FORBIDDEN;
    if (err instanceof PickupUserNotAllowedError) return HttpStatus.FORBIDDEN;
    if (err instanceof TimelineEntryNotAuthorError) return HttpStatus.FORBIDDEN;
    if (err instanceof InvalidAttendancePickupError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (err instanceof InvalidAttendanceTimestampError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (err instanceof InvalidTimelineEntryTypeError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (err instanceof KindergartenNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof NotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof ConflictError) return HttpStatus.CONFLICT;
    if (err instanceof InvariantViolationError) return HttpStatus.BAD_REQUEST;
    if (err instanceof ForbiddenActionError) return HttpStatus.FORBIDDEN;
    if (err instanceof DomainError) return HttpStatus.UNPROCESSABLE_ENTITY;
    return null;
  }
}
