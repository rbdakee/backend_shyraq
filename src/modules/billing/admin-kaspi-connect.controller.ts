import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import {
  KaspiDisconnectResponseDto,
  KaspiInitResponseDto,
  KaspiSendPhoneDto,
  KaspiSendPhoneResponseDto,
  KaspiStatusResponseDto,
  KaspiVerifyOtpDto,
  KaspiVerifyOtpResponseDto,
} from './dto/admin-kaspi-connect.dto';
import { KaspiConnectService } from './kaspi-connect.service';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException('tenant_required');
  return t.kgId;
}

/**
 * AdminKaspiConnectController — the 5 onboarding endpoints from §2.25.
 *
 * Auth: global `JwtAuthGuard` + `KindergartenScopeGuard` (APP_GUARD) +
 * `RolesGuard`@admin here. The connected session is written to the caller's
 * own kindergarten (RLS-scoped via the tenant TX).
 */
@ApiTags('Admin / Billing — Kaspi Connect')
@ApiBearerAuth()
@Controller({ path: 'admin/kaspi', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminKaspiConnectController {
  constructor(private readonly service: KaspiConnectService) {}

  // ── POST /admin/kaspi/connect/init ──────────────────────────────────────

  @Post('connect/init')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start Kaspi onboarding (no SMS is sent).',
    description:
      'Calls Kaspi entrance/step, generates a per-kindergarten device ' +
      'fingerprint, and stores the in-flight state in Redis (TTL 300s). ' +
      'Returns the process_id used by the next two steps.',
  })
  @ApiCreatedResponse({ type: KaspiInitResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiConflictResponse({
    description:
      'kaspi_already_connected — disconnect the active session first.',
  })
  async init(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
  ): Promise<KaspiInitResponseDto> {
    const kgId = requireTenant(t);
    const { processId } = await this.service.init(kgId, user.sub);
    return { process_id: processId };
  }

  // ── POST /admin/kaspi/connect/send-phone ────────────────────────────────

  @Post('connect/send-phone')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit the cashier phone — triggers a REAL Kaspi SMS code.',
  })
  @ApiOkResponse({ type: KaspiSendPhoneResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiBadRequestResponse({
    description: 'kaspi_unknown_process — process_id missing or expired.',
  })
  async sendPhone(
    @Tenant() t: TenantContext,
    @Body() body: KaspiSendPhoneDto,
  ): Promise<KaspiSendPhoneResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.sendPhone(
      kgId,
      body.process_id,
      body.phone,
    );
    return { process_id: result.processId, sms_sent: result.smsSent };
  }

  // ── POST /admin/kaspi/connect/verify-otp ────────────────────────────────

  @Post('connect/verify-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Submit the SMS OTP → auto-finish (ECDH + org-context) → persist session.',
  })
  @ApiOkResponse({ type: KaspiVerifyOtpResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Bearer missing/invalid/revoked, or kaspi_otp_invalid (401).',
  })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiBadRequestResponse({
    description: 'kaspi_unknown_process — process_id missing or expired.',
  })
  async verifyOtp(
    @Tenant() t: TenantContext,
    @Body() body: KaspiVerifyOtpDto,
  ): Promise<KaspiVerifyOtpResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.verifyOtp(
      kgId,
      body.process_id,
      body.otp,
    );
    return {
      connected: result.connected,
      phone: result.phone,
      org_name: result.orgName,
      profile_id: result.profileId,
    };
  }

  // ── GET /admin/kaspi/status ─────────────────────────────────────────────

  @Get('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Current Kaspi connection status (no secrets).',
  })
  @ApiOkResponse({ type: KaspiStatusResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async status(@Tenant() t: TenantContext): Promise<KaspiStatusResponseDto> {
    const kgId = requireTenant(t);
    const s = await this.service.status(kgId);
    return {
      connected: s.connected,
      status: s.status,
      ...(s.phone ? { phone: s.phone } : {}),
      ...(s.orgName ? { org_name: s.orgName } : {}),
      ...(s.lastCheckedAt ? { last_checked_at: s.lastCheckedAt } : {}),
    };
  }

  // ── POST /admin/kaspi/disconnect ────────────────────────────────────────

  @Post('disconnect')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disconnect Kaspi (status=revoked).' })
  @ApiOkResponse({ type: KaspiDisconnectResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({
    description: 'kaspi_not_connected — no session to disconnect.',
  })
  async disconnect(
    @Tenant() t: TenantContext,
  ): Promise<KaspiDisconnectResponseDto> {
    const kgId = requireTenant(t);
    return this.service.disconnect(kgId);
  }
}
