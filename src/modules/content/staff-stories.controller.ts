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
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import { FileUploadError } from './domain/errors/file-upload.error';
import { MediaTypeInvalidError } from './domain/errors/media-type-invalid.error';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ContentPresenter } from './content.presenter';
import { GroupStoryRepository } from './group-story.repository';
import { StoryService } from './story.service';
import { CreateStoryDto } from './dto/staff/create-story.dto';
import { ListStoriesQueryDto } from './dto/staff/list-stories-query.dto';
import { GroupStoryResponseDto } from './dto/responses/group-story-response.dto';
import { StoryListResponseDto } from './dto/responses/story-list-response.dto';

const TENANT_REQUIRED = 'tenant_required';

const STAFF_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const STAFF_MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * B17 T8 MEDIUM#2 — pre-buffer MIME-aware size cap (mirror of the helper
 * in admin-content.controller.ts). Rejects image/* > 10 MB before
 * service-layer processing.
 */
function assertStoryFileWithinPerMimeCap(file: Express.Multer.File): void {
  const mt = (file.mimetype ?? '').toLowerCase();
  if (mt.startsWith('image/')) {
    if (file.size > STAFF_MAX_IMAGE_BYTES) {
      throw new FileUploadError('file_too_large', 'image_over_10mb');
    }
    return;
  }
  if (mt.startsWith('video/')) {
    if (file.size > STAFF_MAX_VIDEO_BYTES) {
      throw new FileUploadError('file_too_large', 'video_over_100mb');
    }
    return;
  }
  throw new MediaTypeInvalidError(mt);
}

/**
 * Staff-side story management (B17 §9.6 / endpoints.md §3.12).
 *
 * Role gate: `mentor` or `admin`. The `POST /:id/view` endpoint is
 * accessible to `parent` as well (see §4.9 — Parent App calls it when the
 * user views a story). Rather than creating a duplicate controller, the
 * method allows both roles via per-method override.
 *
 * Delete guard: the service enforces that only the story author OR a
 * kindergarten admin may delete a story (`canBeDeletedBy` predicate).
 */
@ApiTags('Staff / Stories')
@ApiBearerAuth()
@Controller({ path: 'staff/stories', version: '1' })
@UseGuards(RolesGuard)
@Roles('mentor', 'admin')
export class StaffStoriesController {
  constructor(
    private readonly storyService: StoryService,
    private readonly storyRepo: GroupStoryRepository,
    private readonly groupRepo: GroupRepository,
  ) {}

  // ── CREATE ──────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Publish a story for a group. Multipart: `group_id` (text) + `file` (image or video, required) + optional `caption`. Expires 24 h after creation.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiCreatedResponse({
    type: GroupStoryResponseDto,
    description: 'Story created. expires_at = created_at + 24 h.',
  })
  @ApiBadRequestResponse({
    description:
      'file_upload_error — empty file, missing file, or unsupported media type.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not mentor or admin.' })
  @ApiNotFoundResponse({ description: 'group_not_found.' })
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 100 * 1024 * 1024 } }),
  )
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateStoryDto,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<GroupStoryResponseDto> {
    const kgId = requireTenant(t);
    if (!file) {
      throw new BadRequestException('file_required');
    }
    assertStoryFileWithinPerMimeCap(file);
    const story = await this.storyService.create(
      kgId,
      dto.group_id,
      user.sub,
      {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
        caption: dto.caption ?? null,
      },
      { userId: user.sub, role: user.role as string },
    );
    return ContentPresenter.groupStory(story);
  }

  // ── LIST ─────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary:
      'List active stories (expires_at > now). Mentor: stories of their own groups (or filtered by group_id). Admin: all groups in kg (or filtered by group_id).',
  })
  @ApiOkResponse({ type: StoryListResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not mentor or admin.' })
  async list(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Query() query: ListStoriesQueryDto,
  ): Promise<StoryListResponseDto> {
    const kgId = requireTenant(t);
    const role = user.role as string;

    // Single-group filter shortcut. Admin bypass; mentor must be actively
    // assigned to the requested group (B17 T8 HIGH#4).
    if (query.group_id) {
      if (role === 'mentor') {
        const isAssigned = await this.groupRepo.isUserActiveMentorForGroup(
          kgId,
          user.sub,
          query.group_id,
        );
        if (!isAssigned) {
          throw new ForbiddenActionError(
            'mentor_not_assigned_to_group',
            'Mentor is not assigned to this group',
          );
        }
      }
      const stories = await this.storyService.listActiveByGroup(
        kgId,
        query.group_id,
      );
      return ContentPresenter.storyList(stories);
    }

    if (role === 'admin') {
      // Admin: list all groups, then fetch active stories
      const groups = await this.groupRepo.list(kgId);
      const groupIds = groups.map((g) => g.id);
      if (groupIds.length === 0) return ContentPresenter.storyList([]);
      // Use cross-tenant helper to find active assignments is not needed here —
      // we already have the kg scope. Fetch all active stories across groups.
      const stories = await this.storyRepo.listActiveByGroupIds(
        kgId,
        groupIds,
        new Date(),
      );
      return ContentPresenter.storyList(stories);
    }

    // Mentor: find groups assigned to this user in this kg
    const assignments =
      await this.groupRepo.findActiveMentorAssignmentsByUserIdCrossTenant(
        user.sub,
        kgId,
      );
    if (assignments.length === 0) return ContentPresenter.storyList([]);
    const groupIds = assignments.map((a) => a.groupId);
    const stories = await this.storyRepo.listActiveByGroupIds(
      kgId,
      groupIds,
      new Date(),
    );
    return ContentPresenter.storyList(stories);
  }

  // ── DELETE ──────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a story. Allowed for the story author or a kindergarten admin. Best-effort deletes the media file from storage.',
  })
  @ApiNoContentResponse({ description: 'Story deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'access_denied — not the author and not admin.',
  })
  @ApiNotFoundResponse({ description: 'group_story_not_found.' })
  async delete(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.storyService.delete(kgId, id, {
      userId: user.sub,
      role: user.role as string,
    });
  }

  // ── VIEW ─────────────────────────────────────────────────────────────────
  //
  // Per endpoints.md §3.12 and §4.9 this endpoint is at
  // `POST /staff/stories/:id/view` and is accessible to parent as well
  // (Parent App calls it automatically when the user views a story).
  // Role guard is relaxed here to also allow `parent`.

  @Post(':id/view')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Increment group_stories.views counter. Called by Parent App on story view. Accessible to mentor, admin AND parent.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { views: { type: 'number', example: 6 } },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not mentor, admin, or parent.',
  })
  @ApiNotFoundResponse({ description: 'group_story_not_found.' })
  @ApiGoneResponse({
    description: 'group_story_expired — story has expired (expires_at <= now).',
  })
  @Roles('mentor', 'admin', 'parent')
  async view(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ views: number }> {
    const kgId = requireTenant(t);
    await this.storyService.incrementViews(kgId, id, {
      userId: user.sub,
      role: user.role as string,
    });
    // Re-fetch to return the updated views count.
    const story = await this.storyRepo.findById(kgId, id);
    return { views: story?.views ?? 0 };
  }
}
