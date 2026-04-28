import {
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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { AssignMentorDto } from './dto/assign-mentor.dto';
import { CreateGroupDto } from './dto/create-group.dto';
import { GroupDto, GroupMentorDto } from './dto/group-response.dto';
import { ListGroupsQueryDto } from './dto/list-groups-query.dto';
import { UpdateGroupDto } from './dto/update-group.dto';
import { GroupNotFoundError } from './domain/errors/group-not-found.error';
import { GroupPresenter } from './group.presenter';
import { GroupService } from './group.service';

/**
 * Admin-scoped group endpoints. Wrapped by the global guard chain
 * (`JwtAuthGuard` → `KindergartenScopeGuard` → `RolesGuard`) and the
 * `TenantContextInterceptor` that pins `app.kindergarten_id` for the duration
 * of the handler.
 */
@ApiTags('Groups (Admin)')
@ApiBearerAuth()
@Controller({ path: 'groups', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class GroupController {
  constructor(private readonly service: GroupService) {}

  @Get()
  @ApiOperation({ summary: 'List groups in the caller’s kindergarten.' })
  @ApiOkResponse({ type: [GroupDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() tenant: TenantContext,
    @Query() query: ListGroupsQueryDto,
  ): Promise<GroupDto[]> {
    if (!tenant.kgId) throw new GroupNotFoundError('<no-tenant>');
    const rows = await this.service.list(tenant.kgId, {
      archived: query.archived,
    });
    return rows.map((r) => GroupPresenter.group(r));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a group by id.' })
  @ApiOkResponse({ type: GroupDto })
  @ApiNotFoundResponse({ description: 'Group not found in this tenant.' })
  async getOne(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<GroupDto> {
    if (!tenant.kgId) throw new GroupNotFoundError(id);
    const row = await this.service.getById(tenant.kgId, id);
    return GroupPresenter.group(row);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new group.' })
  @ApiCreatedResponse({ type: GroupDto })
  @ApiBadRequestResponse({
    description:
      'Validation failed (blank name, non-positive capacity, invalid age range).',
  })
  @ApiNotFoundResponse({
    description:
      'Location referenced by current_location_id not found in this tenant.',
  })
  async create(
    @Tenant() tenant: TenantContext,
    @Body() dto: CreateGroupDto,
  ): Promise<GroupDto> {
    if (!tenant.kgId) throw new GroupNotFoundError('<no-tenant>');
    const row = await this.service.create(tenant.kgId, {
      name: dto.name,
      capacity: dto.capacity,
      ageRangeMin: dto.age_range_min ?? null,
      ageRangeMax: dto.age_range_max ?? null,
      currentLocationId: dto.current_location_id ?? null,
    });
    return GroupPresenter.group(row);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a group (partial).' })
  @ApiOkResponse({ type: GroupDto })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiNotFoundResponse({
    description:
      'Group not found, or the new current_location_id does not exist.',
  })
  @ApiConflictResponse({
    description: 'Cannot update an archived group.',
  })
  async update(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGroupDto,
  ): Promise<GroupDto> {
    if (!tenant.kgId) throw new GroupNotFoundError(id);
    const patch: Parameters<GroupService['update']>[2] = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.capacity !== undefined) patch.capacity = dto.capacity;
    if (Object.prototype.hasOwnProperty.call(dto, 'age_range_min')) {
      patch.ageRangeMin = dto.age_range_min ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'age_range_max')) {
      patch.ageRangeMax = dto.age_range_max ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'current_location_id')) {
      patch.currentLocationId = dto.current_location_id ?? null;
    }
    const row = await this.service.update(tenant.kgId, id, patch);
    return GroupPresenter.group(row);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a group (idempotent).' })
  @ApiOkResponse({ type: GroupDto })
  @ApiNotFoundResponse({ description: 'Group not found.' })
  async archive(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<GroupDto> {
    if (!tenant.kgId) throw new GroupNotFoundError(id);
    const row = await this.service.archive(tenant.kgId, id);
    return GroupPresenter.group(row);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived group (idempotent).' })
  @ApiOkResponse({ type: GroupDto })
  async restore(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<GroupDto> {
    if (!tenant.kgId) throw new GroupNotFoundError(id);
    const row = await this.service.restore(tenant.kgId, id);
    return GroupPresenter.group(row);
  }

  // ── mentor assignment ──────────────────────────────────────────────────────

  @Post(':id/mentor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Assign a staff_member as the active mentor for the group. Closes the previous active mentor row in the same TX.',
  })
  @ApiOkResponse({ type: GroupMentorDto })
  @ApiBadRequestResponse({
    description: 'Validation failed (e.g. staff_member_id is not a UUID).',
  })
  @ApiNotFoundResponse({
    description: 'Group or staff_member not found in this tenant.',
  })
  @ApiConflictResponse({
    description:
      'Either the group is archived or two concurrent assignments raced (mentor_already_active).',
  })
  async assignMentor(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignMentorDto,
  ): Promise<GroupMentorDto> {
    if (!tenant.kgId) throw new GroupNotFoundError(id);
    const row = await this.service.assignMentor(
      tenant.kgId,
      id,
      dto.staff_member_id,
    );
    return GroupPresenter.mentor(row);
  }

  @Delete(':id/mentor')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Unassign the currently-active mentor for the group (idempotent — no-op when no active mentor).',
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Group not found.' })
  async unassignMentor(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    if (!tenant.kgId) throw new GroupNotFoundError(id);
    await this.service.unassignMentor(tenant.kgId, id);
  }

  @Get(':id/mentor')
  @ApiOperation({
    summary: 'Get the currently-active mentor for the group, if any.',
  })
  @ApiOkResponse({
    type: GroupMentorDto,
    description: 'Active mentor row, or null when none.',
  })
  async getActiveMentor(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<GroupMentorDto | null> {
    if (!tenant.kgId) throw new GroupNotFoundError(id);
    const row = await this.service.getActiveMentor(tenant.kgId, id);
    return row ? GroupPresenter.mentor(row) : null;
  }

  @Get(':id/mentor-history')
  @ApiOperation({
    summary:
      'Get mentor-assignment history (DESC by assigned_at; includes closed rows).',
  })
  @ApiOkResponse({ type: [GroupMentorDto] })
  async getMentorHistory(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<GroupMentorDto[]> {
    if (!tenant.kgId) throw new GroupNotFoundError(id);
    const rows = await this.service.getMentorHistory(tenant.kgId, id);
    return rows.map((r) => GroupPresenter.mentor(r));
  }
}
