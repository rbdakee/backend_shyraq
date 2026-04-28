import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AllowPendingRoleSelect } from '@/common/decorators/allow-pending-role-select.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Public } from '@/common/decorators/public.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { AuthService } from './auth.service';
import { AuthPresenter } from './auth.presenter';
import {
  AuthResponseDto,
  OtpRequestResponseDto,
} from './dto/auth-response.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { SelectRoleDto } from './dto/select-role.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('otp/request')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request an OTP code via SMS',
    description:
      'Generates a 6-digit code, stores its hash in Redis with a 5-minute TTL, and sends it to the supplied phone via the configured SMS provider. Rate-limited per phone (5 per hour by default).',
  })
  @ApiBody({
    type: RequestOtpDto,
    examples: { default: { value: { phone: '+77012345678' } } },
  })
  @ApiOkResponse({
    type: OtpRequestResponseDto,
    description: 'OTP queued — client should poll the user for the code',
  })
  @ApiBadRequestResponse({ description: 'Phone failed DTO validation' })
  @ApiTooManyRequestsResponse({
    description:
      'Either the per-phone rate limit was exceeded (otp_rate_limit) or the phone is locked out from too many wrong codes (otp_locked).',
  })
  async requestOtp(@Body() dto: RequestOtpDto): Promise<OtpRequestResponseDto> {
    const { resendAfterSec } = await this.auth.requestOtp(dto.phone);
    return { sent: true, resend_after_sec: resendAfterSec };
  }

  @Post('otp/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange an OTP for an access + refresh token pair',
    description:
      'On success returns a Bearer access token, an opaque refresh token (64-char hex, SHA-256 hashed at rest) and the user/role/kindergarten summary. If the user has more than one staff role, returns `pending_role_select: true` and a `null` refresh — the client must call `/auth/role/select` next.',
  })
  @ApiBody({
    type: VerifyOtpDto,
    examples: {
      default: { value: { phone: '+77012345678', code: '123456' } },
    },
  })
  @ApiOkResponse({
    type: AuthResponseDto,
    description: 'Token pair issued (or pending_role_select if multi-role)',
  })
  @ApiBadRequestResponse({
    description: 'invalid_otp or otp_expired_or_missing',
  })
  @ApiTooManyRequestsResponse({
    description: 'Phone locked after 3 wrong attempts (otp_locked)',
  })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() req: Request,
  ): Promise<AuthResponseDto> {
    const result = await this.auth.verifyOtp({
      phone: dto.phone,
      code: dto.code,
      ipAddress: req.ip,
    });
    return AuthPresenter.authResult(result);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rotate the refresh token and issue a new access token',
    description:
      'Atomically revokes the supplied refresh token and inserts a new one carrying forward the same user / kindergarten binding. The old access token (if its `Authorization: Bearer` header is sent) is added to the JTI blocklist for the remainder of its TTL.',
  })
  @ApiBody({
    type: RefreshTokenDto,
    examples: {
      default: {
        value: {
          refreshToken:
            'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        },
      },
    },
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Refresh token unknown, expired, or already revoked',
  })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<AuthResponseDto> {
    const result = await this.auth.refreshToken({
      rawRefreshToken: dto.refreshToken,
      ipAddress: req.ip,
    });
    return AuthPresenter.authResult(result);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard, PendingRoleSelectGuard)
  @AllowPendingRoleSelect()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke the current refresh token + blocklist the access JTI',
    description:
      'Idempotent — calling logout twice is fine. If a refresh token is supplied in the body it is revoked individually; otherwise all the user’s active refresh tokens are revoked.',
  })
  @ApiBody({
    type: RefreshTokenDto,
    required: false,
    examples: {
      withRefresh: {
        value: {
          refreshToken:
            'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
        },
      },
    },
  })
  @ApiNoContentResponse({ description: 'Tokens revoked' })
  @ApiUnauthorizedResponse({ description: 'Bearer token missing or invalid' })
  async logout(
    @CurrentUser() user: JwtPayload,
    @Body() body: Partial<RefreshTokenDto>,
  ): Promise<void> {
    await this.auth.logout({
      userId: user.sub,
      rawRefreshToken: body?.refreshToken,
      accessJti: user.jti,
      accessExpUnix: user.exp,
    });
  }

  @Post('role/select')
  @UseGuards(JwtAuthGuard, PendingRoleSelectGuard)
  @AllowPendingRoleSelect()
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pick a (kindergarten, role) pair to commit the session to',
    description:
      'Used by users with multiple staff roles after a `pending_role_select: true` response from /otp/verify. Issues a fresh token pair scoped to the chosen kindergarten. P2.4 is a stub — no staff_members table exists yet, so every call rejects with `role_not_available`. P3 will wire this up properly.',
  })
  @ApiBody({
    type: SelectRoleDto,
    examples: {
      teacher: {
        value: {
          kindergartenId: '5b3d3b8a-7f4f-4d2a-9c84-9a7c1c1c1c1c',
          role: 'teacher',
        },
      },
    },
  })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse()
  @ApiForbiddenResponse({
    description: 'role_not_available — user has no such role at this kg',
  })
  async selectRole(
    @CurrentUser() user: JwtPayload,
    @Body() dto: SelectRoleDto,
    @Req() req: Request,
  ): Promise<AuthResponseDto> {
    const result = await this.auth.selectRole({
      userId: user.sub,
      kindergartenId: dto.kindergartenId,
      role: dto.role,
      oldAccessJti: user.jti,
      oldAccessExpUnix: user.exp,
      ipAddress: req.ip,
    });
    return AuthPresenter.authResult(result);
  }
}
