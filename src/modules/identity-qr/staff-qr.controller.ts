import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
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
import { ScanQrRequestDto } from './dto/scan-qr-request.dto';
import { ScanQrResponseDto } from './dto/scan-qr-response.dto';
import { QrScanRateLimitExceededError } from './domain/errors/qr-scan-rate-limit-exceeded.error';
import { IdentityQrPresenter } from './identity-qr.presenter';
import { IdentityQrService } from './identity-qr.service';

const DEVICE_ID_HEADER = 'x-device-id';

/**
 * `POST /staff/qr/scan` — staff-side QR resolution.
 *
 * The scanner must be staff in the active tenant (RolesGuard with the four
 * staff roles), but the SCANNED user may be a parent in a different tenant
 * — the service does the cross-tenant lookups via the bypass_rls
 * variants of the guardian/child repos. The `kindergarten_id` GUC set by
 * the global TenantContextInterceptor scopes the staff-side reads (e.g.
 * staff_members) to the caller's kg, while bypass-RLS reads escape it.
 *
 * `X-Device-Id` is required. The service uses it for the per-device 60/min
 * rate-limit AND validates the (userId, deviceId) pair against the
 * caller's active refresh-token rows so the rate-limit cannot be bypassed
 * by rotating arbitrary header values.
 *
 * On 429 we set the standard `Retry-After` header (in seconds) in addition
 * to surfacing `details.retryAfterSeconds` in the JSON body — there is no
 * existing repo precedent for the header, but it's the Web spec for 429.
 */
@ApiTags('Staff / Identity QR')
@ApiBearerAuth()
@Controller({ path: 'staff/qr', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin', 'mentor', 'specialist', 'reception')
export class StaffQrController {
  constructor(private readonly service: IdentityQrService) {}

  @Post('scan')
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
    description:
      'Caller role is not staff (admin/mentor/specialist/reception).',
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
      // list is per-kg. super_admin (no kg claim) falls back to
      // cross-tenant inside the service — the staff-roles guard above
      // already prevents that path in normal operation.
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
}
