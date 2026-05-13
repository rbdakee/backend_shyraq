import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
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
import { ChildPresenter } from './child.presenter';
import { ChildService } from './child.service';
import { RouteDeprecatedError } from './domain/errors/route-deprecated.error';
import {
  ArchiveChildDto,
  AssignGroupDto,
  ChildDto,
  ChildGroupHistoryDto,
  ChildListResponseDto,
  ChildStatusHistoryListResponseDto,
  CreateChildDto,
  GuardianDto,
  InviteGuardianDto,
  ListChildrenQueryDto,
  ListChildStatusHistoryQueryDto,
  ReactivateChildDto,
  TransferChildGroupDto,
  UpdateChildDto,
  UpdateChildPhotoDto,
  UpdateGuardianRolePickupDto,
} from './dto';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/** Response shape for POST :id/reactivate — always includes the tariff hint. */
class ReactivateChildResponseDto {
  @ApiProperty({ type: ChildDto })
  child!: ChildDto;

  @ApiProperty({
    example: true,
    description:
      'Always true — admin must create a new tariff assignment after reactivation.',
  })
  requires_new_tariff_assignment!: true;
}

/**
 * Admin-scoped endpoints over children + child_guardians. Wrapped by the
 * global guard chain (JwtAuthGuard → PendingRoleSelectGuard → RolesGuard) and
 * the TenantContextInterceptor that pins `app.kindergarten_id` for the
 * duration of the handler. The controller itself enforces role membership via
 * `@Roles('admin')` — fine-grained role splits (reception/mentor) live in
 * later phases.
 */
@ApiTags('Children (Admin)')
@ApiBearerAuth()
@Controller({ path: 'children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class ChildController {
  constructor(private readonly service: ChildService) {}

  // ── Children CRUD ──────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a child card.' })
  @ApiCreatedResponse({ type: ChildDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({
    description: 'Provided current_group_id does not exist in this tenant.',
  })
  @ApiConflictResponse({
    description: 'A child with this IIN already exists.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Domain invariant violation (blank name, future DOB, invalid group UUID).',
  })
  async create(
    @Tenant() t: TenantContext,
    @Body() dto: CreateChildDto,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    const child = await this.service.createChild(kgId, {
      fullName: dto.full_name,
      iin: dto.iin,
      dateOfBirth: new Date(dto.date_of_birth),
      gender: dto.gender,
      photoUrl: dto.photo_url,
      currentGroupId: dto.current_group_id,
      medicalNotes: dto.medical_notes,
      allergyNotes: dto.allergy_notes,
    });
    return ChildPresenter.child(child);
  }

  @Get()
  @ApiOperation({ summary: 'List children with filters and pagination.' })
  @ApiOkResponse({ type: ChildListResponseDto })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListChildrenQueryDto,
  ): Promise<ChildListResponseDto> {
    const kgId = requireTenant(t);
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const result = await this.service.listChildren(
      kgId,
      {
        status: query.status,
        currentGroupId: query.current_group_id,
        q: query.q,
      },
      { limit, offset },
    );
    return {
      data: result.items.map((c) => ChildPresenter.child(c)),
      meta: { total: result.total, limit, offset },
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a child card with the full guardians list.',
  })
  @ApiOkResponse({
    schema: {
      properties: {
        child: { $ref: '#/components/schemas/ChildDto' },
        guardians: {
          type: 'array',
          items: { $ref: '#/components/schemas/GuardianDto' },
        },
      },
    },
  })
  @ApiNotFoundResponse({ description: 'Child not found in this tenant.' })
  async getOne(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ child: ChildDto; guardians: GuardianDto[] }> {
    const kgId = requireTenant(t);
    const out = await this.service.getChild(kgId, id);
    return {
      child: ChildPresenter.child(out.child),
      guardians: out.guardians.map((g) => ChildPresenter.guardian(g)),
    };
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update child profile (partial).' })
  @ApiOkResponse({ type: ChildDto })
  @ApiNotFoundResponse({ description: 'Child not found.' })
  @ApiConflictResponse({
    description: 'New IIN conflicts with an existing card.',
  })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateChildDto,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    const child = await this.service.updateChildProfile(kgId, id, {
      fullName: dto.full_name,
      iin: dto.iin,
      dateOfBirth: dto.date_of_birth ? new Date(dto.date_of_birth) : undefined,
      gender: dto.gender,
      photoUrl: dto.photo_url,
      medicalNotes: dto.medical_notes,
      allergyNotes: dto.allergy_notes,
    });
    return ChildPresenter.child(child);
  }

  @Post(':id/photo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update or clear the child photo URL.' })
  @ApiOkResponse({ type: ChildDto })
  @ApiNotFoundResponse({ description: 'Child not found.' })
  async updatePhoto(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateChildPhotoDto,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    const child = await this.service.updateChildPhoto(kgId, id, dto.photo_url);
    return ChildPresenter.child(child);
  }

  @Post(':id/group')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Assign a child to a group (idempotent).' })
  @ApiOkResponse({ type: ChildDto })
  @ApiNotFoundResponse({ description: 'Child or group not found.' })
  async assignGroup(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignGroupDto,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    const child = await this.service.assignChildToGroup(kgId, id, dto.group_id);
    return ChildPresenter.child(child);
  }

  @Delete(':id/group')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detach a child from its current group.' })
  @ApiOkResponse({ type: ChildDto })
  async unassignGroup(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    const child = await this.service.unassignChildFromGroup(kgId, id);
    return ChildPresenter.child(child);
  }

  @Post(':id/transfer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Transfer the child to a new group and append a child_group_history row.',
    description:
      'TX: UPDATE children.current_group_id + INSERT child_group_history(transferred_by_staff_id). 422 if target equals current.',
  })
  @ApiOkResponse({ type: ChildDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({
    description: 'Bearer missing / invalid / revoked.',
  })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Child or target group not found.' })
  @ApiConflictResponse({
    description: 'No conflict scenarios; included for completeness.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'group_transfer_to_self — to_group_id equals current group.',
    schema: {
      example: {
        statusCode: 422,
        error: 'group_transfer_to_self',
        message: 'group_transfer_to_self',
      },
    },
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  async transferGroup(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: TransferChildGroupDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    const staffId = await this.service.resolveStaffMemberIdForUser(
      kgId,
      user.sub,
    );
    const child = await this.service.transferChildToGroup(
      kgId,
      id,
      dto.to_group_id,
      staffId,
      dto.reason ?? null,
    );
    return ChildPresenter.child(child);
  }

  @Get(':id/group-history')
  @ApiOperation({ summary: 'Group transfer history (oldest → newest).' })
  @ApiOkResponse({ type: [ChildGroupHistoryDto] })
  async groupHistory(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChildGroupHistoryDto[]> {
    const kgId = requireTenant(t);
    const rows = await this.service.listChildGroupHistory(kgId, id);
    return rows.map((r) => ChildPresenter.groupHistory(r));
  }

  /**
   * B22a T9 — append-only audit of `children.status` transitions
   * (archive / reactivate / future card_created→active). Admin-only;
   * mentors and parents see the current status through the regular
   * child-detail endpoint. Paginated via `?limit=&offset=` (per-child
   * volume is small — offset pagination is sufficient).
   */
  @Get(':id/status-history')
  @ApiOperation({
    summary: 'Child status-change audit history (newest → oldest).',
    description:
      'Returns paginated rows from `child_status_history`. Each row records ' +
      'the previous and new status, the (optional) archive reason, and the ' +
      'users.id of the actor who triggered the change. Admin-only.',
  })
  @ApiOkResponse({ type: ChildStatusHistoryListResponseDto })
  @ApiNotFoundResponse({
    description: 'Child not found in this tenant.',
    schema: {
      example: {
        statusCode: 404,
        error: 'child_not_found',
        message: 'child_not_found',
      },
    },
  })
  @ApiUnauthorizedResponse({
    description: 'Bearer missing / invalid / revoked.',
  })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async statusHistory(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: ListChildStatusHistoryQueryDto,
  ): Promise<ChildStatusHistoryListResponseDto> {
    const kgId = requireTenant(t);
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const page = await this.service.listStatusHistory(kgId, id, limit, offset);
    return {
      items: page.items.map((r) => ChildPresenter.statusHistory(r)),
      total: page.total,
    };
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Archive a child card.',
    description:
      'Closes any active tariff assignments and enqueues a pro-rata refund job. ' +
      'Emits a child.archived outbox event. Idempotent at the HTTP level — ' +
      'a second call returns 409 child_already_archived.',
  })
  @ApiOkResponse({ type: ChildDto })
  @ApiBadRequestResponse({
    description: 'Validation error (e.g. blank reason).',
  })
  @ApiUnauthorizedResponse({
    description: 'Bearer missing / invalid / revoked.',
  })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({
    description: 'Child not found.',
    schema: {
      example: {
        statusCode: 404,
        error: 'child_not_found',
        message: 'child_not_found',
      },
    },
  })
  @ApiConflictResponse({
    description: 'Child is already archived.',
    schema: {
      example: {
        statusCode: 409,
        error: 'child_already_archived',
        message: 'child_already_archived',
      },
    },
  })
  @ApiUnprocessableEntityResponse({
    description: 'archive_reason is empty or exceeds 500 characters.',
    schema: {
      example: {
        statusCode: 422,
        error: 'archive_reason_required',
        message: 'archive_reason_required',
      },
    },
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  async archive(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ArchiveChildDto,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    const staffId = await this.service.resolveStaffMemberIdForUser(
      kgId,
      user!.sub,
    );
    const child = await this.service.archiveChild(
      kgId,
      id,
      dto.archive_reason,
      staffId,
      user!.sub,
    );
    return ChildPresenter.child(child);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reactivate an archived child.',
    description:
      'Clears archived_at / archive_reason and sets status back to active. ' +
      'Tariff assignments are NOT restored automatically — the admin must ' +
      'create a new assignment via POST /admin/tariff-assignments. ' +
      'The response always includes requires_new_tariff_assignment: true as a hint.',
  })
  @ApiOkResponse({
    type: ReactivateChildResponseDto,
    description: 'Child reactivated; new tariff assignment required.',
  })
  @ApiUnauthorizedResponse({
    description: 'Bearer missing / invalid / revoked.',
  })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({
    description: 'Child not found.',
    schema: {
      example: {
        statusCode: 404,
        error: 'child_not_found',
        message: 'child_not_found',
      },
    },
  })
  @ApiConflictResponse({
    description: 'Child is not archived.',
    schema: {
      example: {
        statusCode: 409,
        error: 'child_not_archived',
        message: 'child_not_archived',
      },
    },
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limited.' })
  async reactivate(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() _dto: ReactivateChildDto,
  ): Promise<ReactivateChildResponseDto> {
    const kgId = requireTenant(t);
    const staffId = await this.service.resolveStaffMemberIdForUser(
      kgId,
      user!.sub,
    );
    const result = await this.service.reactivateChild(
      kgId,
      id,
      staffId,
      user!.sub,
    );
    return {
      child: ChildPresenter.child(result.child),
      requires_new_tariff_assignment: true,
    };
  }

  /**
   * B22a T11: removed — endpoint returns 410 Gone with `Location` header.
   * The route definition stays so legacy clients receive a documented
   * "endpoint_gone" code rather than the indistinguishable router-level 404
   * they'd hit if we deleted the @Post() too. Full route-level removal is
   * scheduled for B22b once client telemetry confirms zero hits.
   *
   * @deprecated Use POST /api/v1/children/:id/reactivate.
   */
  @Post(':id/restore')
  @ApiOperation({
    summary: 'DEPRECATED — returns 410 Gone (use /reactivate).',
    deprecated: true,
    description:
      'Removed in B22a T11. All callers must migrate to ' +
      'POST /api/v1/children/:id/reactivate. Response carries a Location ' +
      'header pointing at the successor and an `endpoint_gone` error code.',
  })
  @ApiGoneResponse({
    description: 'Endpoint replaced by /reactivate.',
    schema: {
      example: {
        statusCode: 410,
        error: 'endpoint_gone',
        message: 'endpoint replaced by /api/v1/children/:id/reactivate',
        details: {
          successor: '/api/v1/children/:id/reactivate',
        },
      },
    },
  })
  restore(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res({ passthrough: true }) res: Response,
  ): never {
    const successor = `/api/v1/children/${id}/reactivate`;
    res.setHeader('Location', successor);
    throw new RouteDeprecatedError(successor);
  }

  // ── Guardians (admin) ──────────────────────────────────────────────────

  @Get(':id/guardians')
  @ApiOperation({ summary: 'List all guardians of the child.' })
  @ApiOkResponse({ type: [GuardianDto] })
  async listGuardians(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<GuardianDto[]> {
    const kgId = requireTenant(t);
    // Tenant scope guard: confirm child exists in this kg before exposing guardians.
    const exists = await this.service.getChild(kgId, id);
    return exists.guardians.map((g) => ChildPresenter.guardian(g));
  }

  @Post(':id/guardians')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Invite a guardian for the child. find-or-create user by phone or by user_id.',
  })
  @ApiBody({ type: InviteGuardianDto })
  @ApiCreatedResponse({ type: GuardianDto })
  @ApiBadRequestResponse({
    description: 'Provide exactly one of user_phone or user_id.',
  })
  @ApiNotFoundResponse({ description: 'Child or user not found.' })
  @ApiConflictResponse({ description: 'guardian_already_exists.' })
  async inviteGuardian(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: InviteGuardianDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<GuardianDto> {
    const kgId = requireTenant(t);
    if ((dto.user_phone === undefined) === (dto.user_id === undefined)) {
      throw new BadRequestException({
        error: 'validation_failed',
        message: 'provide exactly one of user_phone or user_id',
      });
    }
    const guardian = await this.service.inviteGuardian(kgId, {
      childId: id,
      userPhone: dto.user_phone,
      userId: dto.user_id,
      role: dto.role,
      canPickup: dto.can_pickup,
      invitedByUserId: user.sub,
    });
    return ChildPresenter.guardian(guardian);
  }

  @Patch(':id/guardians/:guardianId')
  @ApiOperation({
    summary:
      'Update guardian role and/or can_pickup. has_approval_rights is parent-only.',
  })
  @ApiOkResponse({ type: GuardianDto })
  @ApiNotFoundResponse({ description: 'Guardian not found.' })
  @ApiUnprocessableEntityResponse({
    description: 'invalid_guardian_status_transition.',
  })
  async updateGuardian(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('guardianId', new ParseUUIDPipe()) guardianId: string,
    @Body() dto: UpdateGuardianRolePickupDto,
  ): Promise<GuardianDto> {
    const kgId = requireTenant(t);
    const guardian = await this.service.updateGuardianRoleAndPickup(
      kgId,
      id,
      guardianId,
      { role: dto.role, canPickup: dto.can_pickup },
    );
    return ChildPresenter.guardian(guardian);
  }

  @Post(':id/guardians/:guardianId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Admin-side revoke (sets revoked_at + revoked_by = current admin).',
  })
  @ApiOkResponse({ type: GuardianDto })
  @ApiNotFoundResponse({ description: 'Guardian not found.' })
  async revokeGuardian(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('guardianId', new ParseUUIDPipe()) guardianId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<GuardianDto> {
    const kgId = requireTenant(t);
    const guardian = await this.service.revokeGuardianByAdmin(
      kgId,
      id,
      guardianId,
      user.sub,
    );
    return ChildPresenter.guardian(guardian);
  }
}
