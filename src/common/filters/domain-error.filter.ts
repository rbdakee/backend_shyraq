import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ConflictError,
  DomainError,
  ForbiddenActionError,
  GoneError,
  InvariantViolationError,
  NotFoundError,
  TooManyRequestsError,
  UnprocessableEntityError,
} from '@/shared-kernel/domain/errors';
import { IinAlreadyTakenError } from '@/modules/users/domain/errors/iin-already-taken.error';
import { ProfileUniqueViolationError } from '@/modules/users/domain/errors/profile-unique-violation.error';
import { InvalidCredentialsError } from '@/modules/auth/domain/errors/invalid-credentials.error';
import { NoActiveRolesError } from '@/modules/auth/domain/errors/no-active-roles.error';
import { NoRoleForAppError } from '@/modules/auth/domain/errors/no-role-for-app.error';
import { NotInvitedError } from '@/modules/auth/domain/errors/not-invited.error';
import { OtpExpiredError } from '@/modules/auth/domain/errors/otp-expired.error';
import { OtpInvalidError } from '@/modules/auth/domain/errors/otp-invalid.error';
import { OtpLockedError } from '@/modules/auth/domain/errors/otp-locked.error';
import { OtpRateLimitedError } from '@/modules/auth/domain/errors/otp-rate-limited.error';
import { RefreshInvalidError } from '@/modules/auth/domain/errors/refresh-invalid.error';
import { RoleNotAvailableError } from '@/modules/auth/domain/errors/role-not-available.error';
import { RoleSelectNotRequiredError } from '@/modules/auth/domain/errors/role-select-not-required.error';
import { SaasLoginRateLimitError } from '@/modules/auth/domain/errors/saas-login-rate-limit.error';
import { FiscalSettingsForbiddenError } from '@/modules/kindergarten/domain/errors/fiscal-settings-forbidden.error';
import { KindergartenArchivedError } from '@/modules/kindergarten/domain/errors/kindergarten-archived.error';
import { KindergartenNotFoundError } from '@/modules/kindergarten/domain/errors/kindergarten-not-found.error';
import { KindergartenSlugTakenError } from '@/modules/kindergarten/domain/errors/kindergarten-slug-taken.error';
import { SpecialistTypeNotFoundError } from '@/modules/specialist-type/domain/errors/specialist-type-not-found.error';
import { AdminAlreadyExistsError } from '@/modules/staff/domain/errors/admin-already-exists.error';
import { StaffAlreadyExistsError } from '@/modules/staff/domain/errors/staff-already-exists.error';
import { ArchiveReasonRequiredError } from '@/modules/child/domain/errors/archive-reason-required.error';
import { ArchivedChildNotTransferableError } from '@/modules/child/domain/errors/archived-child-not-transferable.error';
import { ChildActivationRequiresTariffError } from '@/modules/child/domain/errors/child-activation-requires-tariff.error';
import { ChildAlreadyArchivedError } from '@/modules/child/domain/errors/child-already-archived.error';
import { ChildNotArchivedError } from '@/modules/child/domain/errors/child-not-archived.error';
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
import { InvalidTimelineMetadataError } from '@/modules/attendance/domain/errors/invalid-timeline-metadata.error';
import { PickupUserNotAllowedError } from '@/modules/attendance/domain/errors/pickup-user-not-allowed.error';
import { TimelineEntryNotAuthorError } from '@/modules/attendance/domain/errors/timeline-entry-not-author.error';
import { TimelineEntryNotFoundError } from '@/modules/attendance/domain/errors/timeline-entry-not-found.error';
import { InvalidEventKeyError } from '@/modules/notification/domain/errors/invalid-event-key.error';
import { NotificationNotFoundError } from '@/modules/notification/domain/errors/notification-not-found.error';
import { PushTokenNotFoundError } from '@/modules/notification/domain/errors/push-token-not-found.error';
import { PaymentProviderError } from '@/modules/billing/domain/errors/payment-provider.error';
import { PaymentProviderUnavailableError } from '@/modules/billing/domain/errors/payment-provider-unavailable.error';
import {
  KaspiAppVersionOutdatedError,
  KaspiFinishFailedError,
  KaspiInvalidPhoneError,
  KaspiOtpInvalidError,
  KaspiPhoneRequiredError,
  KaspiUnknownProcessError,
  KaspiWebhookUnsupportedError,
} from '@/modules/billing/domain/errors/kaspi-connect.errors';
import { KaspiRefundHistoryAckRequiredError } from '@/modules/billing/domain/errors/kaspi-refund-history-ack-required.error';
import {
  BccConnectionCheckFailedError,
  BccGatewayUnavailableError,
} from '@/modules/billing/domain/errors/bcc-connection-check.error';
import {
  BccCallbackInvalidError,
  BccCallbackUnauthorizedError,
} from '@/modules/billing/domain/errors/bcc-callback.error';
import {
  FileStorageMalformedKeyError,
  FileStorageNotFoundError,
  FileStorageTransientError,
} from '@/modules/content/domain/errors/file-upload.error';

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

    // Pass NestJS HttpExceptions (ForbiddenException, UnauthorizedException,
    // BadRequestException, etc.) through with their own serialised body so
    // controllers that throw `new ForbiddenException('nanny_cannot_view')` get
    // the standard { statusCode, message, error } response format.
    if (exception instanceof HttpException) {
      const httpStatus = exception.getStatus();
      const httpBody = exception.getResponse();
      if (typeof httpBody === 'object' && httpBody !== null) {
        res.status(httpStatus).json(httpBody);
      } else {
        res
          .status(httpStatus)
          .json({ statusCode: httpStatus, message: String(httpBody) });
      }
      return;
    }

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
    if (err instanceof SaasLoginRateLimitError)
      return HttpStatus.TOO_MANY_REQUESTS;
    if (err instanceof OtpExpiredError) return HttpStatus.BAD_REQUEST;
    if (err instanceof OtpInvalidError) return HttpStatus.BAD_REQUEST;
    if (err instanceof InvalidCredentialsError) return HttpStatus.UNAUTHORIZED;
    if (err instanceof RefreshInvalidError) return HttpStatus.UNAUTHORIZED;
    if (err instanceof RoleNotAvailableError) return HttpStatus.FORBIDDEN;
    if (err instanceof RoleSelectNotRequiredError) return HttpStatus.FORBIDDEN;
    if (err instanceof NoActiveRolesError) return HttpStatus.FORBIDDEN;
    if (err instanceof NoRoleForAppError) return HttpStatus.FORBIDDEN;
    if (err instanceof NotInvitedError) return HttpStatus.NOT_FOUND;
    if (err instanceof IinAlreadyTakenError) return HttpStatus.CONFLICT;
    if (err instanceof ProfileUniqueViolationError) return HttpStatus.CONFLICT;
    if (err instanceof KindergartenSlugTakenError) return HttpStatus.CONFLICT;
    if (err instanceof KindergartenArchivedError) return HttpStatus.CONFLICT;
    if (err instanceof StaffAlreadyExistsError) return HttpStatus.CONFLICT;
    if (err instanceof AdminAlreadyExistsError) return HttpStatus.CONFLICT;
    if (err instanceof FiscalSettingsForbiddenError)
      return HttpStatus.FORBIDDEN;
    // Children & guardians — B21 archive/reactivate lifecycle errors
    if (err instanceof ChildAlreadyArchivedError) return HttpStatus.CONFLICT;
    if (err instanceof ArchivedChildNotTransferableError)
      return HttpStatus.CONFLICT;
    if (err instanceof ChildNotArchivedError) return HttpStatus.CONFLICT;
    if (err instanceof ChildActivationRequiresTariffError)
      return HttpStatus.CONFLICT;
    if (err instanceof ArchiveReasonRequiredError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
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
    if (err instanceof InvalidTimelineMetadataError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    // B9 Notifications
    if (err instanceof NotificationNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof PushTokenNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof InvalidEventKeyError) return HttpStatus.BAD_REQUEST;
    // B13 Billing — payment provider failures (T11 H5).
    // PaymentProviderError → 502 Bad Gateway; the raw provider reason is
    // intentionally NOT propagated to the response body (only `details.provider`).
    if (err instanceof PaymentProviderError) return HttpStatus.BAD_GATEWAY;
    if (err instanceof PaymentProviderUnavailableError)
      return HttpStatus.BAD_REQUEST;
    if (
      err instanceof BccGatewayUnavailableError ||
      err instanceof BccConnectionCheckFailedError
    ) {
      return HttpStatus.BAD_GATEWAY;
    }
    if (err instanceof BccCallbackUnauthorizedError)
      return HttpStatus.UNAUTHORIZED;
    if (err instanceof BccCallbackInvalidError) return HttpStatus.BAD_REQUEST;
    // B24 Kaspi onboarding (§2.25). 409/404 fall through to the Conflict/
    // NotFound base branches below; these three need explicit mappings.
    if (err instanceof KaspiUnknownProcessError) return HttpStatus.BAD_REQUEST;
    if (err instanceof KaspiInvalidPhoneError) return HttpStatus.BAD_REQUEST;
    if (err instanceof KaspiOtpInvalidError) return HttpStatus.UNAUTHORIZED;
    // K6 — Kaspi payment adapter errors.
    // kaspi_phone_required → 400 (clean path is the K7 DTO guard; this maps it
    // for direct callers that bypass PaymentService's provider catch-all).
    if (err instanceof KaspiPhoneRequiredError) return HttpStatus.BAD_REQUEST;
    // K9 — refusal to process a kaspi_pay refund without an explicit
    // "I checked the Kaspi history" acknowledgement (Kaspi has no idempotency
    // key, so a blind retry may double-refund). → 400, matching the K9
    // parent-pay `payment_provider_unavailable` 400.
    if (err instanceof KaspiRefundHistoryAckRequiredError)
      return HttpStatus.BAD_REQUEST;
    // kaspi_webhook_unsupported → 501 (Kaspi has no inbound callback; settlement
    // is via the K8 poller). Matches docs/endpoints.md §4.5 error catalog.
    if (err instanceof KaspiWebhookUnsupportedError)
      return HttpStatus.NOT_IMPLEMENTED;
    // Both Kaspi-upstream failures map to 502 (mirrors PaymentProviderError);
    // the raw Kaspi reason is kept server-side only, never in the body.
    if (err instanceof KaspiAppVersionOutdatedError)
      return HttpStatus.BAD_GATEWAY;
    if (err instanceof KaspiFinishFailedError) return HttpStatus.BAD_GATEWAY;
    // B22b T9 — discriminated file-storage errors.
    // MalformedKey → 400 (bad request, never retry)
    // NotFound     → 404 (key missing from store)
    // Transient    → 503 (infrastructure failure, caller may retry)
    if (err instanceof FileStorageMalformedKeyError)
      return HttpStatus.BAD_REQUEST;
    if (err instanceof FileStorageNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof FileStorageTransientError)
      return HttpStatus.SERVICE_UNAVAILABLE;
    if (err instanceof KindergartenNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof SpecialistTypeNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof NotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof ConflictError) return HttpStatus.CONFLICT;
    if (err instanceof GoneError) return HttpStatus.GONE;
    if (err instanceof TooManyRequestsError)
      return HttpStatus.TOO_MANY_REQUESTS;
    if (err instanceof InvariantViolationError) return HttpStatus.BAD_REQUEST;
    if (err instanceof ForbiddenActionError) return HttpStatus.FORBIDDEN;
    if (err instanceof UnprocessableEntityError)
      return HttpStatus.UNPROCESSABLE_ENTITY;
    if (err instanceof DomainError) return HttpStatus.UNPROCESSABLE_ENTITY;
    return null;
  }
}
