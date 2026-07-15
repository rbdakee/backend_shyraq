import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { RevokeAllQrResponseDto } from './dto/revoke-all-qr-response.dto';
import { ScanQrRequestDto } from './dto/scan-qr-request.dto';
import { ScanQrResponseDto } from './dto/scan-qr-response.dto';
import { QrScanRateLimitExceededError } from './domain/errors/qr-scan-rate-limit-exceeded.error';
import { IdentityQrPresenter } from './identity-qr.presenter';
import { IdentityQrService } from './identity-qr.service';

const DEVICE_ID_HEADER = 'x-device-id';

/**
 * Admin web-panel surface for Identity QR:
 *   - `POST /admin/qr/revoke-all/:userId` — admin-only bulk-revoke.
 *   - `POST /admin/qr/scan` — thin alias of `POST /staff/qr/scan`.
 *
 * Roles: the class-level `@Roles('admin')` is the default; `scan` widens to
 * `admin + reception` with a method-level `@Roles`. `RolesGuard` resolves
 * via `reflector.getAllAndOverride(ROLES_KEY, [getHandler(), getClass()])`,
 * so the method-level list OVERRIDES (not merges with) the class-level one
 * — `revoke-all` therefore stays admin-only.
 *
 * revoke-all semantics
 * --------------------
 * Stamps `revoked_at` on every active `user_qr_tokens` row for the target
 * user, then clears `qr:user:{userId}:identity` Redis (so the next user
 * GET mints fresh). Plaintext-keyed Redis (`qr:token:{plaintext}`) is NOT
 * invalidated — admin only has hashes — so subsequent scans rely on the
 * service's DB recheck to surface `qr_token_revoked` (410). Cache TTL is
 * ≤24h so stale-hit exposure is bounded.
 *
 * Tenant scoping: the QR rows themselves are cross-tenant (one QR per user
 * across kindergartens), but the admin authorization is kg-scoped — the
 * service rejects with 403 `user_no_relationship_to_kindergarten` unless
 * the target user is an active staff_member in caller's kg or an approved
 * (non-revoked) child_guardian for a child in caller's kg. Unknown userId
 * → 404 `user_not_found`. The route inherits caller's kg from the JWT
 * via `KindergartenScopeGuard`.
 */
@ApiTags('Admin / Identity QR')
@ApiBearerAuth()
@Controller({ path: 'admin/qr', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class AdminQrController {
  constructor(private readonly service: IdentityQrService) {}

  /**
   * Alias of `POST /staff/qr/scan` for the admin web panel — same
   * `IdentityQrService.scan()` call, no duplicated logic. It exists purely
   * so the panel is not forced onto a `/staff/...` path; `/staff/qr/scan`
   * already permits `admin` and stays the canonical route for the mobile
   * staff app.
   *
   * IDENTITY ONLY — this writes NO attendance. The scan resolves who the
   * QR belongs to and what they may do (`allowedActions`); recording a
   * check-in/check-out is a SEPARATE follow-up call the caller must make.
   * The only write here is the `last_scanned_at` stamp on the token row.
   *
   * `X-Device-Id` caveat: the service compares this header with `=`
   * against `device_id` on the CALLER's active refresh-token rows (this
   * binding is what stops the per-device rate-limit being bypassed by
   * rotating the header). A client that logged in WITHOUT sending
   * `X-Device-Id` at `/auth/otp/verify` has `NULL` persisted on its
   * refresh-token row, which never `=`-matches any header value — such a
   * session gets 401 `no_active_session_for_device` on every scan, no
   * matter what it sends. The admin panel must therefore send the same
   * `X-Device-Id` at OTP-verify AND on every scan.
   */
  @Post('scan')
  // Method-level @Roles OVERRIDES the class-level @Roles('admin') —
  // RolesGuard reads via getAllAndOverride([handler, class]). Widening
  // here does not leak `reception` into `revoke-all` above. Matches
  // AdminAttendanceController's @Roles('admin', 'reception'), since a
  // reception desk scanning at the gate is the primary caller.
  @Roles('admin', 'reception')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Resolve a scanned Identity QR. Returns the user identity + (parent-only) linked children + per-role allowed_actions.',
  })
  @ApiHeader({
    name: 'X-Device-Id',
    required: true,
    description:
      'Device id used at OTP-verify. Must match an active refresh_token row for the calling user.',
  })
  @ApiOkResponse({ type: ScanQrResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error / missing X-Device-Id.',
  })
  @ApiUnauthorizedResponse({
    description:
      'Bearer missing/invalid/revoked OR no active session for X-Device-Id.',
  })
  @ApiForbiddenResponse({
    description: 'Caller role is not admin/reception.',
  })
  @ApiNotFoundResponse({ description: 'qr_token_not_found.' })
  @ApiGoneResponse({
    description: 'qr_token_expired or qr_token_revoked.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'qr_rate_limit_exceeded — 60 calls per 60s budget on X-Device-Id is exhausted.',
  })
  async scan(
    @CurrentUser() user: JwtPayload,
    @Headers(DEVICE_ID_HEADER) deviceId: string | undefined,
    @Body() dto: ScanQrRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ScanQrResponseDto> {
    if (!deviceId || deviceId.length === 0) {
      throw new BadRequestException('X-Device-Id header required');
    }
    try {
      // Pass the caller's kg from the JWT so the service can scope
      // `linkedChildren` to it. Token identity is cross-tenant; the kid
      // list is per-kg.
      const result = await this.service.scan(
        user.sub,
        deviceId,
        dto.token,
        user.kindergarten_id ?? null,
      );
      return IdentityQrPresenter.scan(result);
    } catch (err) {
      if (err instanceof QrScanRateLimitExceededError) {
        // Standard 429 hint — DomainErrorFilter still serializes the body
        // and chooses the status; we just append the header here.
        res.setHeader('Retry-After', String(err.details.retryAfterSeconds));
      }
      throw err;
    }
  }

  @Post('revoke-all/:userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Bulk-revoke every active Identity QR token for the given user. Returns the number of rows just stamped revoked_at.',
  })
  @ApiOkResponse({ type: RevokeAllQrResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not admin OR target user has no active staff_member / approved guardian relationship with caller’s kindergarten (`user_no_relationship_to_kindergarten`).',
  })
  @ApiNotFoundResponse({
    description: 'Target userId does not exist (`user_not_found`).',
  })
  async revokeAll(
    @CurrentUser() admin: JwtPayload,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<RevokeAllQrResponseDto> {
    // RolesGuard@admin guarantees the caller is an admin in some kg, so
    // `kindergarten_id` is a non-null UUID on the JWT. Defensive guard
    // anyway because a misconfigured guard chain would otherwise let the
    // service receive `undefined` and crash.
    if (!admin.kindergarten_id) {
      throw new InternalServerErrorException(
        'admin caller missing kindergarten_id claim',
      );
    }
    const { revokedCount } = await this.service.revokeAllByUser(
      admin.sub,
      userId,
      admin.kindergarten_id,
    );
    return IdentityQrPresenter.revokeAll(revokedCount);
  }
}
