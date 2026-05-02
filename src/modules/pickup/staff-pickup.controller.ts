import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { StaffCreatePickupRequestDto } from './dto/create-pickup-request.dto';
import { ListPickupRequestsQueryDto } from './dto/list-pickup-requests-query.dto';
import {
  PickupRequestResponseDto,
  SendPickupOtpResponseDto,
  ValidatePickupOtpResponseDto,
} from './dto/pickup-request-response.dto';
import { ValidatePickupOtpDto } from './dto/validate-pickup-otp.dto';
import { PickupPresenter } from './pickup.presenter';
import { PickupRequestService } from './pickup-request.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff-side pickup-request endpoints (B11). Roles: mentor + admin.
 *
 *   GET    /staff/pickup-requests
 *   GET    /staff/pickup-requests/:id
 *   POST   /staff/pickup-requests
 *   POST   /staff/pickup-requests/:id/send-otp
 *   POST   /staff/pickup-requests/:id/validate-otp
 *   POST   /staff/pickup-requests/:id/cancel
 *
 * The validate-otp call is the heart of the flow: it accepts a 6-digit
 * code dictated by the trusted person, transitions `pickup_requests` to
 * `validated`, and writes a paired `attendance_events` row via
 * AttendanceService — all under an advisory lock keyed on the request id.
 */
@ApiTags('Staff / Pickup')
@ApiBearerAuth()
@Controller({ path: 'staff/pickup-requests', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('mentor', 'admin')
export class StaffPickupController {
  constructor(private readonly service: PickupRequestService) {}

  // ── List ───────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary:
      'List pickup requests for the staff’s kindergarten. Filters: groupId, status.',
  })
  @ApiOkResponse({ type: [PickupRequestResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() q: ListPickupRequestsQueryDto,
  ): Promise<PickupRequestResponseDto[]> {
    const kgId = requireTenant(t);
    const items = await this.service.listByKindergarten(kgId, {
      groupId: q.groupId ?? null,
      status: q.status ?? null,
    });
    return items.map((pr) => PickupPresenter.pickupRequest(pr));
  }

  // ── Get ────────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get pickup request by id.' })
  @ApiOkResponse({ type: PickupRequestResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({ description: 'pickup_request_not_found.' })
  async getOne(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PickupRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.getById(kgId, id);
    return PickupPresenter.pickupRequest(pr);
  }

  // ── Create — staff branch ──────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Staff creates a pickup_request — either bound to an existing trusted_people row (whitelist) or ad-hoc (snapshot fields on body).',
  })
  @ApiCreatedResponse({ type: PickupRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller role not allowed OR trusted_person belongs to a different child (`trusted_person_not_for_child`).',
  })
  @ApiNotFoundResponse({
    description:
      'child_not_found, trusted_person_not_found, staff_member not found.',
  })
  @ApiGoneResponse({
    description:
      'trusted_person_revoked — the whitelisted trusted person is no longer eligible.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: StaffCreatePickupRequestDto,
  ): Promise<PickupRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.createByStaff(kgId, user.sub, {
      childId: dto.child_id,
      trustedPersonId: dto.trusted_person_id ?? null,
      trustedPersonName: dto.trusted_person_name,
      trustedPersonPhone: dto.trusted_person_phone,
      trustedPersonIin: dto.trusted_person_iin ?? null,
    });
    return PickupPresenter.pickupRequest(pr);
  }

  // ── Send OTP ───────────────────────────────────────────────────────────

  @Post(':id/send-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Generate a 6-digit OTP, store it in Redis (TTL 1800s), SMS to the trusted-person phone, fan out `pickup.otp_sent` notification.',
  })
  @ApiOkResponse({ type: SendPickupOtpResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({
    description: 'pickup_request_not_found / child_not_found.',
  })
  @ApiConflictResponse({
    description:
      'pickup_request_status_invalid — request is not in `otp_sent` (cancelled, validated, or already expired).',
  })
  @ApiTooManyRequestsResponse({
    description:
      'otp_rate_limit — per-phone OTP request budget exhausted (shared with auth login).',
  })
  async sendOtp(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<SendPickupOtpResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.sendOtp(kgId, id);
    return PickupPresenter.sendOtp(result);
  }

  // ── Validate OTP ───────────────────────────────────────────────────────

  @Post(':id/validate-otp')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Validate the 6-digit OTP dictated by the trusted person. On success transitions to `validated`, creates the paired attendance_event (check-out), and notifies guardians + requester. Wrapped in `pg_advisory_xact_lock` so concurrent attempts serialize.',
  })
  @ApiOkResponse({ type: ValidatePickupOtpResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error (code shape).' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({
    description: 'pickup_request_not_found / staff_member not found.',
  })
  @ApiConflictResponse({
    description:
      'pickup_request_already_validated OR pickup_request_status_invalid.',
  })
  @ApiGoneResponse({ description: 'pickup_request_expired.' })
  @ApiBadRequestResponse({
    description: 'invalid_otp / otp_expired_or_missing.',
  })
  @ApiTooManyRequestsResponse({
    description: 'otp_locked — too many failed attempts on this request.',
  })
  async validate(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ValidatePickupOtpDto,
  ): Promise<ValidatePickupOtpResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.validateOtp(kgId, id, dto.code, user.sub);
    return PickupPresenter.validateOtp(result);
  }

  // ── Cancel ─────────────────────────────────────────────────────────────

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a pickup_request that has not yet been validated. Clears the OTP cache key. Idempotent at the SQL layer; surfaces `pickup_request_status_invalid` (409) for terminal-state requests.',
  })
  @ApiOkResponse({ type: PickupRequestResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({ description: 'pickup_request_not_found.' })
  @ApiConflictResponse({ description: 'pickup_request_status_invalid.' })
  async cancel(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<PickupRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.cancel(kgId, id);
    return PickupPresenter.pickupRequest(pr);
  }
}
