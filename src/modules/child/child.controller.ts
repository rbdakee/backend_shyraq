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
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
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
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ChildPresenter } from './child.presenter';
import { ChildService } from './child.service';
import {
  ArchiveChildDto,
  AssignGroupDto,
  ChildDto,
  ChildGroupHistoryDto,
  ChildListResponseDto,
  CreateChildDto,
  GuardianDto,
  InviteGuardianDto,
  ListChildrenQueryDto,
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
  @ApiNotFoundResponse({ description: 'Child or target group not found.' })
  @ApiUnprocessableEntityResponse({
    description: 'group_transfer_to_self.',
  })
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

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a child card (idempotent).' })
  @ApiOkResponse({ type: ChildDto })
  async archive(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ArchiveChildDto,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    // B21 T3 wires the real archive flow; T4 will replace this controller
    // path with a dedicated DTO carrying both `reason` and the resolved
    // `archivedByStaffId`. Passing an empty actor id here keeps the legacy
    // path compiling — the service still emits the outbox event and
    // closes tariff assignments.
    const child = await this.service.archiveChild(
      kgId,
      id,
      dto.reason ?? '',
      '',
    );
    return ChildPresenter.child(child);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived child card (idempotent).' })
  @ApiOkResponse({ type: ChildDto })
  async restore(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ChildDto> {
    const kgId = requireTenant(t);
    const child = await this.service.restoreChild(kgId, id);
    return ChildPresenter.child(child);
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
