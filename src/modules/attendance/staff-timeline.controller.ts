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
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
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
import { TimelineEntry } from './domain/entities/timeline-entry.entity';
import { CreateTimelineEntryDto } from './dto/create-timeline-entry.dto';
import { ListTimelineQuery } from './dto/list-timeline.query';
import { PatchTimelineEntryDto } from './dto/patch-timeline-entry.dto';
import {
  PagedTimelineResponseDto,
  TimelineEntryResponseDto,
} from './dto/timeline-entry.response';
import { TimelinePresenter } from './timeline.presenter';
import { TimelineService } from './timeline.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff-scoped timeline endpoints (B8 T4).
 *
 * Roles: mentor, specialist, reception. Group-mentor scope enforcement
 * (mentor must be assigned to the child's group) is deferred until B22:
 * // TODO(B22): tighten mentor-group scope on timeline writes.
 */
@ApiTags('Staff / Timeline')
@ApiBearerAuth()
@Controller({ path: 'staff', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('mentor', 'specialist', 'reception')
export class StaffTimelineController {
  constructor(private readonly service: TimelineService) {}

  @Post('timeline-entries')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a manual timeline entry (activity / meal / nap / note / photo / mood / medication). check_in and check_out are reserved for the attendance flow.',
  })
  @ApiCreatedResponse({ type: TimelineEntryResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({
    description: 'child_not_found / staff_member not found.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'invalid_timeline_entry_type — entry_type check_in/check_out is reserved.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate-limited.' })
  async createEntry(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateTimelineEntryDto,
  ): Promise<TimelineEntryResponseDto> {
    const kgId = requireTenant(t);
    const entry = await this.service.createEntry(
      kgId,
      dto.childId,
      user.sub,
      {
        entryType: dto.entryType,
        title: dto.title ?? null,
        body: dto.body ?? null,
        mediaUrls: dto.mediaUrls ?? null,
        metadata: dto.metadata ?? null,
        entryTime: dto.entryTime,
      },
      { isAdmin: false, callerRole: user.role },
    );
    return this.presentEntry(kgId, entry);
  }

  @Patch('timeline-entries/:entryId')
  @ApiOperation({
    summary:
      'Update a timeline entry. Only the author may edit (403 timeline_entry_not_author for non-admin non-author).',
  })
  @ApiOkResponse({ type: TimelineEntryResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller role not allowed / timeline_entry_not_author (non-author non-admin).',
  })
  @ApiNotFoundResponse({ description: 'timeline_entry_not_found.' })
  async updateEntry(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('entryId', new ParseUUIDPipe()) entryId: string,
    @Body() dto: PatchTimelineEntryDto,
  ): Promise<TimelineEntryResponseDto> {
    const kgId = requireTenant(t);
    const updated = await this.service.updateEntry(
      kgId,
      entryId,
      user.sub,
      {
        title: dto.title,
        body: dto.body,
        mediaUrls: dto.mediaUrls,
        metadata: dto.metadata,
        entryTime: dto.entryTime,
      },
      { isAdmin: false, callerRole: user.role },
    );
    return this.presentEntry(kgId, updated);
  }

  @Delete('timeline-entries/:entryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a timeline entry. Only the author may delete (403 for non-author non-admin).',
  })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'timeline_entry_not_author or role not allowed.',
  })
  @ApiNotFoundResponse({ description: 'timeline_entry_not_found.' })
  async deleteEntry(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('entryId', new ParseUUIDPipe()) entryId: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.deleteEntry(kgId, entryId, user.sub, {
      isAdmin: false,
      callerRole: user.role,
    });
  }

  @Get('timeline/child/:childId')
  @ApiOperation({
    summary:
      'Paginated timeline for a child. Ordered by entry_time DESC. Supports cursor-based paging.',
  })
  @ApiOkResponse({ type: PagedTimelineResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller role not allowed.' })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async listByChild(
    @Tenant() t: TenantContext,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() q: ListTimelineQuery,
  ): Promise<PagedTimelineResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.listByChild(kgId, childId, {
      limit: q.limit,
      cursor: q.cursor,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
    });
    const recordedByNames = await this.service.resolveRecordedByNames(
      kgId,
      result.items,
    );
    return TimelinePresenter.paged(
      result.items,
      result.nextCursor,
      recordedByNames,
    );
  }

  /**
   * Resolve the `recorded_by` identity overlay (staff_members.id →
   * users.full_name) for a single timeline entry and hand it to the
   * presenter. Batched through the service resolver; for one row the map has
   * at most one entry.
   */
  private async presentEntry(
    kgId: string,
    entry: TimelineEntry,
  ): Promise<TimelineEntryResponseDto> {
    const recordedByNames = await this.service.resolveRecordedByNames(kgId, [
      entry,
    ]);
    return TimelinePresenter.entry(
      entry,
      entry.recordedBy ? (recordedByNames.get(entry.recordedBy) ?? null) : null,
    );
  }
}
