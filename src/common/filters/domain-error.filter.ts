import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  DomainError,
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
    res.status(status).json({
      statusCode: status,
      error: code,
      message: code,
    });
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
    if (err instanceof KindergartenNotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof NotFoundError) return HttpStatus.NOT_FOUND;
    if (err instanceof InvariantViolationError) return HttpStatus.BAD_REQUEST;
    if (err instanceof DomainError) return HttpStatus.UNPROCESSABLE_ENTITY;
    return null;
  }
}
