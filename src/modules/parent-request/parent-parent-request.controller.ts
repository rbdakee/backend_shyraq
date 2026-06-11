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
import { ChildBodyAccessGuard } from '@/common/guards/child-body-access.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { ParentRequestAccessGuard } from '@/common/guards/parent-request-access.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { AddMessageDto } from './dto/add-message.dto';
import { CreateDayOffRequestDto } from './dto/create-day-off-request.dto';
import { CreateLatePickupRequestDto } from './dto/create-late-pickup-request.dto';
import { CreateOpenRequestDto } from './dto/create-open-request.dto';
import { CreateTrustedPersonRequestDto } from './dto/create-trusted-person-request.dto';
import { CreateVacationRequestDto } from './dto/create-vacation-request.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { ListParentRequestsQueryDto } from './dto/list-parent-requests-query.dto';
import { OtpRequestDto, OtpRequestResponseDto } from './dto/otp-request.dto';
import {
  ParentRequestMessageListResponseDto,
  ParentRequestMessageResponseDto,
} from './dto/parent-request-message.response.dto';
import {
  ParentRequestListResponseDto,
  ParentRequestResponseDto,
} from './dto/parent-request.response.dto';
import { ParentRequestPresenter } from './parent-request.presenter';
import { ParentRequestService } from './parent-request.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Parent-side parent-requests endpoints (B12). All endpoints under
 * `/parent/requests/*`.
 *
 * Tenant resolution — derived from the RESOURCE, not the JWT (the parent token
 * carries `kindergarten_id: null` by design for multi-kg parents, so token-kg
 * is only an optimisation slice, never the source of truth):
 *   - CREATE routes (`child_id` in body) → `ChildBodyAccessGuard` resolves the
 *     child cross-tenant, admits an approved guardian, and pins `req.tenant` to
 *     the child's kg. The service then re-checks the `create_requests`
 *     permission in that kg.
 *   - `:id` routes (get / cancel / messages) → `ParentRequestAccessGuard`
 *     resolves the request cross-tenant by id and pins `req.tenant` to the
 *     request's kg. The service then enforces requester-ownership in that kg.
 *   - `list` → kg-scoped fast-path when the token carries a kg, else a
 *     cross-tenant fan-out over the caller's own requests in every kg.
 *
 * Rate-limit: per-user `rate:parent_requests:create:{userId}` (30/hour) on
 * each create endpoint. The OTP-request endpoint piggybacks on auth's
 * shared `rate:otp:{phone}` window (5/hour) so abusing this surface cannot
 * earn extra login OTP budget.
 */
@ApiTags('Parent / Requests')
@ApiBearerAuth()
@Controller({ path: 'parent/requests', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('parent')
export class ParentParentRequestController {
  constructor(private readonly service: ParentRequestService) {}

  // ── List + get ────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary:
      "List the caller's own parent_requests. Filters: status, type, child_id. Cursor paginated.",
  })
  @ApiOkResponse({ type: ParentRequestListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  async list(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Query() q: ListParentRequestsQueryDto,
  ): Promise<ParentRequestListResponseDto> {
    // Two paths — token-kg is only an optimisation slice, never required:
    //   - kg-scoped JWT (single-kg parent) → list inside that tenant (RLS) and
    //     resolve staff display names (kg-scoped lookup works).
    //   - unscoped JWT (multi-kg parent)   → cross-tenant fan-out over the
    //     caller's own requests in every kg. Staff display names are left null
    //     (a kg-scoped staff lookup under an unscoped transaction sees nothing)
    //     — correctness over completeness, mirroring `ParentChildController`.
    if (t.kgId) {
      const result = await this.service.listForParent(t.kgId, user.sub, {
        status: q.status,
        type: q.type,
        childId: q.child_id,
        limit: q.limit,
        cursor: q.cursor ?? null,
      });
      const staffNames = await this.service.resolveRequestStaffNames(
        t.kgId,
        result.items,
      );
      return ParentRequestPresenter.list(
        result.items,
        result.nextCursor,
        staffNames,
      );
    }

    const result = await this.service.listForParentCrossTenant(user.sub, {
      status: q.status,
      type: q.type,
      childId: q.child_id,
      limit: q.limit,
      cursor: q.cursor ?? null,
    });
    return ParentRequestPresenter.list(
      result.items,
      result.nextCursor,
      new Map<string, string | null>(),
    );
  }

  @Get(':id')
  @UseGuards(ParentRequestAccessGuard)
  @ApiOperation({
    summary: 'Get a parent_request by id. Requester-ownership enforced.',
  })
  @ApiOkResponse({ type: ParentRequestResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'parent_request_forbidden.' })
  @ApiNotFoundResponse({ description: 'parent_request_not_found.' })
  async getOne(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.getByIdForParent(kgId, user.sub, id);
    const staffNames = await this.service.resolveRequestStaffNames(kgId, [pr]);
    return ParentRequestPresenter.requestWithStaffNames(pr, staffNames);
  }

  // ── OTP request (trusted-person flow) ─────────────────────────────────

  @Post('otp-request')
  @UseGuards(ChildBodyAccessGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Request an OTP code for the trusted-person sub-flow. Generates a 6-digit code, stores under `otp:request:trusted-person:{userId}` (TTL 1800s), and sends it to the requesting parent's own registered phone (re-auth). Per-phone rate-limit shared with auth login (`rate:otp:{phone}`).",
  })
  @ApiOkResponse({ type: OtpRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'parent_request_forbidden / create_request_permission_required.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'otp_rate_limit / otp_locked — too many OTP requests on this phone, or too many failed attempts on this user.',
  })
  async requestOtp(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: OtpRequestDto,
  ): Promise<OtpRequestResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.sendOtpForTrustedPerson(
      kgId,
      user.sub,
      dto.child_id,
    );
    return { otp_ref: result.otpRef, expires_in: result.expiresIn };
  }

  // ── Create per type ───────────────────────────────────────────────────

  @Post('trusted-person')
  @UseGuards(ChildBodyAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Submit a trusted_person request — verifies the OTP code in the same TX as the parent_request insert.',
  })
  @ApiCreatedResponse({ type: ParentRequestResponseDto })
  @ApiBadRequestResponse({ description: 'invalid_otp / validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'parent_request_forbidden / create_request_permission_required.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  @ApiConflictResponse({ description: 'state-machine race (rare on create).' })
  @ApiGoneResponse({ description: 'otp_expired_or_missing.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'otp_rate_limit / otp_locked — burnt-out attempts or per-user create-rate exceeded.',
  })
  async createTrustedPerson(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTrustedPersonRequestDto,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.createTrustedPersonRequest(kgId, user.sub, {
      code: dto.code,
      childId: dto.child_id,
      fullName: dto.full_name,
      phone: dto.phone,
      iin: dto.iin ?? null,
      relation: dto.relation,
      photoUrl: dto.photo_url ?? null,
      isOneTime: dto.is_one_time ?? false,
      createPickupRequest: dto.create_pickup_request ?? false,
      comment: dto.comment ?? null,
    });
    const staffNames = await this.service.resolveRequestStaffNames(kgId, [pr]);
    return ParentRequestPresenter.requestWithStaffNames(pr, staffNames);
  }

  @Post('day-off')
  @UseGuards(ChildBodyAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Submit a day_off request — child stays IN садик on a weekend (Sat/Sun). 1 or 2 dates, both in the same calendar week if 2.',
  })
  @ApiCreatedResponse({ type: ParentRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'parent_request_forbidden / create_request_permission_required.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  @ApiUnprocessableEntityResponse({
    description:
      'parent_request_weekend_dates_count_invalid / parent_request_weekend_date_in_past / parent_request_weekend_date_not_weekend / parent_request_weekend_dates_different_weeks.',
  })
  @ApiTooManyRequestsResponse({
    description: 'otp_rate_limit — per-user create budget exceeded.',
  })
  async createDayOff(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateDayOffRequestDto,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.createDayOffRequest(kgId, user.sub, {
      childId: dto.child_id,
      weekendDates: dto.weekend_dates,
      comment: dto.comment ?? null,
    });
    const staffNames = await this.service.resolveRequestStaffNames(kgId, [pr]);
    return ParentRequestPresenter.requestWithStaffNames(pr, staffNames);
  }

  @Post('vacation')
  @UseGuards(ChildBodyAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Submit a vacation request — child takes [date_from..date_to] OUT of the садик.',
  })
  @ApiCreatedResponse({ type: ParentRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'parent_request_forbidden / create_request_permission_required.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  @ApiUnprocessableEntityResponse({
    description:
      'parent_request_date_from_in_past / parent_request_date_range_invalid.',
  })
  @ApiTooManyRequestsResponse({
    description: 'otp_rate_limit — per-user create budget exceeded.',
  })
  async createVacation(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateVacationRequestDto,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.createVacationRequest(kgId, user.sub, {
      childId: dto.child_id,
      dateFrom: dto.date_from,
      dateTo: dto.date_to,
      comment: dto.comment ?? null,
    });
    const staffNames = await this.service.resolveRequestStaffNames(kgId, [pr]);
    return ParentRequestPresenter.requestWithStaffNames(pr, staffNames);
  }

  @Post('late-pickup')
  @UseGuards(ChildBodyAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Submit a late_pickup request — parent will arrive after closing on `date` at `expected_time`.',
  })
  @ApiCreatedResponse({ type: ParentRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'parent_request_forbidden / create_request_permission_required.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  @ApiUnprocessableEntityResponse({
    description:
      'parent_request_expected_time_invalid / parent_request_date_in_past.',
  })
  @ApiTooManyRequestsResponse({
    description: 'otp_rate_limit — per-user create budget exceeded.',
  })
  async createLatePickup(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateLatePickupRequestDto,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.createLatePickupRequest(kgId, user.sub, {
      childId: dto.child_id,
      date: dto.date,
      expectedTime: dto.expected_time,
      comment: dto.comment ?? null,
    });
    const staffNames = await this.service.resolveRequestStaffNames(kgId, [pr]);
    return ParentRequestPresenter.requestWithStaffNames(pr, staffNames);
  }

  @Post('open')
  @UseGuards(ChildBodyAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Submit an open_request — free-form question routed to admin / mentor / specialist.',
  })
  @ApiCreatedResponse({ type: ParentRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'parent_request_forbidden / create_request_permission_required.',
  })
  @ApiNotFoundResponse({
    description: 'child_not_found / staff_member not found.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'parent_request_recipient_staff_required (specialist) / parent_request_recipient_role_mismatch.',
  })
  @ApiTooManyRequestsResponse({
    description: 'otp_rate_limit — per-user create budget exceeded.',
  })
  async createOpen(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateOpenRequestDto,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.createOpenRequest(kgId, user.sub, {
      childId: dto.child_id,
      recipientType: dto.recipient_type,
      recipientStaffId: dto.recipient_staff_id ?? null,
      subject: dto.subject,
      message: dto.message,
      attachments: dto.attachments ?? null,
    });
    const staffNames = await this.service.resolveRequestStaffNames(kgId, [pr]);
    return ParentRequestPresenter.requestWithStaffNames(pr, staffNames);
  }

  // ── Cancel ────────────────────────────────────────────────────────────

  @Post(':id/cancel')
  @UseGuards(ParentRequestAccessGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a pending parent_request you created. Conditional UPDATE — losing the race vs staff accept/reject surfaces 409 already_processed.',
  })
  @ApiOkResponse({ type: ParentRequestResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'parent_request_forbidden.' })
  @ApiNotFoundResponse({ description: 'parent_request_not_found.' })
  @ApiConflictResponse({ description: 'parent_request_already_processed.' })
  async cancel(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.cancelRequest(kgId, user.sub, id);
    const staffNames = await this.service.resolveRequestStaffNames(kgId, [pr]);
    return ParentRequestPresenter.requestWithStaffNames(pr, staffNames);
  }

  // ── Thread ────────────────────────────────────────────────────────────

  @Post(':id/messages')
  @UseGuards(ParentRequestAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Post a parent message to the request thread.',
  })
  @ApiCreatedResponse({ type: ParentRequestMessageResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'parent_request_forbidden.' })
  @ApiNotFoundResponse({ description: 'parent_request_not_found.' })
  async postMessage(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AddMessageDto,
  ): Promise<ParentRequestMessageResponseDto> {
    const kgId = requireTenant(t);
    const m = await this.service.addParentMessage(kgId, user.sub, id, {
      body: dto.body,
      attachments: dto.attachments ?? null,
    });
    const authorNames = await this.service.resolveMessageAuthorNames(kgId, [m]);
    return ParentRequestPresenter.message(m, authorNames.get(m.id) ?? null);
  }

  @Get(':id/messages')
  @UseGuards(ParentRequestAccessGuard)
  @ApiOperation({
    summary:
      'List messages in the request thread. Cursor-based; `next_cursor` is an ISO timestamp.',
  })
  @ApiOkResponse({ type: ParentRequestMessageListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'parent_request_forbidden.' })
  @ApiNotFoundResponse({ description: 'parent_request_not_found.' })
  async listMessages(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() q: ListMessagesQueryDto,
  ): Promise<ParentRequestMessageListResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.listMessagesForParent(
      kgId,
      user.sub,
      id,
      q.limit ?? 50,
      q.cursor ?? null,
    );
    const authorNames = await this.service.resolveMessageAuthorNames(
      kgId,
      result.items,
    );
    return ParentRequestPresenter.messageList(
      result.items,
      result.nextCursor,
      authorNames,
    );
  }
}
