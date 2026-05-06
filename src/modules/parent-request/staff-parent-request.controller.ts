import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import {
  StaffMember,
  StaffRole,
} from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { AddMessageDto } from './dto/add-message.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { ListParentRequestsQueryDto } from './dto/list-parent-requests-query.dto';
import {
  ParentRequestMessageListResponseDto,
  ParentRequestMessageResponseDto,
} from './dto/parent-request-message.response.dto';
import {
  ParentRequestListResponseDto,
  ParentRequestResponseDto,
} from './dto/parent-request.response.dto';
import { ReviewRequestDto } from './dto/review-request.dto';
import { ParentRequestPresenter } from './parent-request.presenter';
import {
  CallerStaffContext,
  ParentRequestService,
} from './parent-request.service';

const TENANT_REQUIRED = 'tenant_required';
const STAFF_NOT_FOUND = 'staff_member_not_found';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff-side parent_requests endpoints (B12). Roles: mentor + specialist + admin.
 *
 *   GET    /staff/parent-requests
 *   GET    /staff/parent-requests/:id
 *   POST   /staff/parent-requests/:id/accept
 *   POST   /staff/parent-requests/:id/reject
 *   POST   /staff/parent-requests/:id/messages
 *   GET    /staff/parent-requests/:id/messages
 *
 * Authorisation per row is service-side: admin sees everything in the kg;
 * mentor / specialist see only requests routed to their staff_member_id.
 */
@ApiTags('Staff / Parent Requests')
@ApiBearerAuth()
@Controller({ path: 'staff/parent-requests', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('mentor', 'specialist', 'admin')
export class StaffParentRequestController {
  constructor(
    private readonly service: ParentRequestService,
    private readonly staffRepo: StaffMemberRepository,
  ) {}

  // ── List + get ────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary:
      'Inbox view for the caller. Admin sees everything in kg; mentor / specialist see only requests routed to their staff_member.',
  })
  @ApiOkResponse({ type: ParentRequestListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  async list(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Query() q: ListParentRequestsQueryDto,
  ): Promise<ParentRequestListResponseDto> {
    const kgId = requireTenant(t);
    const caller = await this.resolveCaller(kgId, user);
    const result = await this.service.listForStaffInbox(kgId, caller, {
      status: q.status,
      type: q.type,
      childId: q.child_id,
      groupId: q.group_id,
      limit: q.limit,
      cursor: q.cursor ?? null,
    });
    return ParentRequestPresenter.list(result.items, result.nextCursor);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a parent_request by id.' })
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
    const caller = await this.resolveCaller(kgId, user);
    const pr = await this.service.getByIdForStaff(kgId, caller, id);
    return ParentRequestPresenter.request(pr);
  }

  // ── Accept / Reject ───────────────────────────────────────────────────

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Accept a pending parent_request. Conditional UPDATE — concurrent staff hits map exactly one to success and the rest to 409 already_processed.',
  })
  @ApiOkResponse({ type: ParentRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'parent_request_forbidden.' })
  @ApiNotFoundResponse({ description: 'parent_request_not_found.' })
  @ApiConflictResponse({ description: 'parent_request_already_processed.' })
  @ApiUnprocessableEntityResponse({
    description:
      'parent_request_trusted_person_details_invalid (defensive — DTO usually catches first).',
  })
  async accept(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReviewRequestDto,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const caller = await this.resolveCaller(kgId, user);
    const pr = await this.service.acceptRequest(
      kgId,
      caller,
      id,
      dto.review_note ?? null,
    );
    return ParentRequestPresenter.request(pr);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reject a pending parent_request. Conditional UPDATE — concurrent staff hits map exactly one to success and the rest to 409.',
  })
  @ApiOkResponse({ type: ParentRequestResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'parent_request_forbidden.' })
  @ApiNotFoundResponse({ description: 'parent_request_not_found.' })
  @ApiConflictResponse({ description: 'parent_request_already_processed.' })
  async reject(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReviewRequestDto,
  ): Promise<ParentRequestResponseDto> {
    const kgId = requireTenant(t);
    const caller = await this.resolveCaller(kgId, user);
    const pr = await this.service.rejectRequest(
      kgId,
      caller,
      id,
      dto.review_note ?? null,
    );
    return ParentRequestPresenter.request(pr);
  }

  // ── Thread ────────────────────────────────────────────────────────────

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Post a staff message to the request thread.' })
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
    const caller = await this.resolveCaller(kgId, user);
    const m = await this.service.addStaffMessage(kgId, caller, id, {
      body: dto.body,
      attachments: dto.attachments ?? null,
    });
    return ParentRequestPresenter.message(m);
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'List messages in the request thread. Cursor-paginated.',
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
    const caller = await this.resolveCaller(kgId, user);
    const result = await this.service.listMessagesForStaff(
      kgId,
      caller,
      id,
      q.limit ?? 50,
      q.cursor ?? null,
    );
    return ParentRequestPresenter.messageList(result.items, result.nextCursor);
  }

  // ── helpers ───────────────────────────────────────────────────────────

  /**
   * Resolves the caller's `staff_member` row in this kg and packages a
   * `CallerStaffContext` for the service. Returns 404 when the caller has
   * no staff record (shouldn't happen if RolesGuard let them in — defensive
   * symmetry with B11 staff endpoints).
   */
  private async resolveCaller(
    kgId: string,
    user: JwtPayload,
  ): Promise<CallerStaffContext> {
    const staff: StaffMember | null =
      await this.staffRepo.findActiveByUserAndKindergarten(user.sub, kgId);
    if (!staff) {
      throw new NotFoundException(STAFF_NOT_FOUND);
    }
    return {
      staffMemberId: staff.id,
      userId: staff.userId,
      role: staff.role as StaffRole,
    };
  }
}
