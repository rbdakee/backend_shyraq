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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ContentPresenter } from './content.presenter';
import { ContentService } from './content.service';
import { CreateContentDto } from './dto/admin/create-content.dto';
import { ListContentQueryDto } from './dto/admin/list-content-query.dto';
import { ScheduleContentDto } from './dto/admin/schedule-content.dto';
import { UpdateContentDto } from './dto/admin/update-content.dto';
import { ContentListResponseDto } from './dto/responses/content-list-response.dto';
import { ContentPostResponseDto } from './dto/responses/content-post-response.dto';
import { UploadMediaResponseDto } from './dto/responses/upload-media-response.dto';
import type {
  ContentTargetType,
  ContentType,
  LocalisedText,
} from './domain/entities/content-post.entity';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin CRUD + state-machine for `content_posts` (B17 §9 / endpoints.md §2.10).
 *
 * All endpoints are kg-scoped. The global `JwtAuthGuard` + `KindergartenScopeGuard`
 * run first; `RolesGuard` then enforces `admin` role on top.
 *
 * Media upload flow (multipart):
 *   `POST /admin/content` accepts up to 5 files via `files` field. For each
 *   file the controller calls `service.uploadMedia()` to obtain a URL, then
 *   creates the post with `media_urls` populated. `PATCH /:id` follows the
 *   same pattern — any files submitted are uploaded and appended.
 */
@ApiTags('Admin / Content')
@ApiBearerAuth()
@Controller({ path: 'admin/content', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminContentController {
  constructor(private readonly service: ContentService) {}

  // ── CREATE ──────────────────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Create a content post draft (or scheduled if scheduled_for is provided). Supports up to 5 media file uploads via multipart/form-data `files` field.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiCreatedResponse({
    type: ContentPostResponseDto,
    description: 'Post created. Default status: draft.',
  })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({
    description:
      'group_not_found / child_not_found when target references a missing entity.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'content_target_invalid — target_type/target_id mismatch.',
  })
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateContentDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<ContentPostResponseDto> {
    const kgId = requireTenant(t);
    const mediaUrls: string[] = [];
    for (const file of files ?? []) {
      const result = await this.service.uploadMedia(kgId, {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      });
      mediaUrls.push(result.url);
    }
    const post = await this.service.create(
      kgId,
      {
        contentType: dto.content_type as ContentType,
        targetType: dto.target_type as ContentTargetType,
        targetGroupId: dto.target_group_id ?? null,
        targetChildId: dto.target_child_id ?? null,
        title: dto.title ?? null,
        body: dto.body ?? null,
        titleI18n: (dto.title_i18n as LocalisedText) ?? null,
        bodyI18n: (dto.body_i18n as LocalisedText) ?? null,
        mediaUrls: mediaUrls.length > 0 ? mediaUrls : null,
        metadata: dto.metadata ?? null,
        scheduledFor: dto.scheduled_for ? new Date(dto.scheduled_for) : null,
        expiresAt: dto.expires_at ? new Date(dto.expires_at) : null,
      },
      user.sub,
    );
    return ContentPresenter.contentPost(post);
  }

  // ── LIST ────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({
    summary:
      'List content posts with filters. Supports cursor-pagination (cursor + limit).',
  })
  @ApiOkResponse({ type: ContentListResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListContentQueryDto,
  ): Promise<ContentListResponseDto> {
    const kgId = requireTenant(t);
    const posts = await this.service.list(kgId, {
      contentType: query.content_type as ContentType | undefined,
      status: query.status as 'draft' | 'scheduled' | 'published' | undefined,
      targetType: query.target_type as ContentTargetType | undefined,
      targetGroupId: query.target_group_id,
      targetChildId: query.target_child_id,
      scheduledFrom: query.scheduled_from
        ? new Date(query.scheduled_from)
        : undefined,
      scheduledTo: query.scheduled_to
        ? new Date(query.scheduled_to)
        : undefined,
      publishedFrom: query.published_from
        ? new Date(query.published_from)
        : undefined,
      publishedTo: query.published_to
        ? new Date(query.published_to)
        : undefined,
      cursorId: query.cursor,
      limit: query.limit,
    });
    // No cursor-in-response supported by current repo (simple list).
    // Return null cursor until pagination is implemented end-to-end.
    return ContentPresenter.contentList(posts, null);
  }

  // ── DETAIL ──────────────────────────────────────────────────────────────

  @Get(':id')
  @ApiOperation({ summary: 'Get a single content post by id.' })
  @ApiOkResponse({ type: ContentPostResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'content_post_not_found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContentPostResponseDto> {
    const kgId = requireTenant(t);
    const post = await this.service.getById(kgId, id);
    return ContentPresenter.contentPost(post);
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Update a content post (draft or scheduled only). Optionally attach new media files via multipart `files` field.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiOkResponse({ type: ContentPostResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'content_post_not_found.' })
  @ApiConflictResponse({
    description: 'content_post_status_invalid — cannot edit a published post.',
  })
  @ApiUnprocessableEntityResponse({
    description: 'content_target_invalid — target mismatch.',
  })
  @UseInterceptors(
    FilesInterceptor('files', 5, {
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateContentDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<ContentPostResponseDto> {
    const kgId = requireTenant(t);
    const newMediaUrls: string[] = [];
    for (const file of files ?? []) {
      const result = await this.service.uploadMedia(kgId, {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      });
      newMediaUrls.push(result.url);
    }

    const patch: Parameters<ContentService['update']>[2] = {
      title: dto.title,
      body: dto.body,
      titleI18n: dto.title_i18n as LocalisedText | null | undefined,
      bodyI18n: dto.body_i18n as LocalisedText | null | undefined,
      metadata: dto.metadata,
      expiresAt: dto.expires_at
        ? new Date(dto.expires_at)
        : (dto.expires_at as null | undefined),
      targetType: dto.target_type as ContentTargetType | undefined,
      targetGroupId: dto.target_group_id,
      targetChildId: dto.target_child_id,
      ...(dto.scheduled_for !== undefined
        ? {
            scheduledFor: dto.scheduled_for
              ? new Date(dto.scheduled_for)
              : null,
          }
        : {}),
    };
    if (newMediaUrls.length > 0) {
      patch.mediaUrls = newMediaUrls;
    } else if ('media_urls' in dto) {
      patch.mediaUrls = null;
    }

    const post = await this.service.update(kgId, id, patch);
    return ContentPresenter.contentPost(post);
  }

  // ── DELETE ──────────────────────────────────────────────────────────────

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a content post. Only allowed from draft status. Also best-effort-deletes media files from storage.',
  })
  @ApiNoContentResponse({ description: 'Post deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'content_post_not_found.' })
  @ApiConflictResponse({
    description:
      'content_cannot_delete_published — post is published or scheduled.',
  })
  async delete(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.delete(kgId, id);
  }

  // ── PUBLISH ─────────────────────────────────────────────────────────────

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Immediately publish a post (draft → published OR scheduled → published). Sets published_at=now and emits notification event.',
  })
  @ApiOkResponse({ type: ContentPostResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'content_post_not_found.' })
  @ApiConflictResponse({
    description: 'content_already_published — post is already published.',
  })
  async publish(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ContentPostResponseDto> {
    const kgId = requireTenant(t);
    const post = await this.service.publish(kgId, id);
    return ContentPresenter.contentPost(post);
  }

  // ── SCHEDULE ────────────────────────────────────────────────────────────

  @Post(':id/schedule')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Schedule a draft post for future publication. Transitions draft → scheduled.',
  })
  @ApiOkResponse({ type: ContentPostResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'content_post_not_found.' })
  @ApiConflictResponse({
    description: 'content_post_status_invalid — post is not in draft status.',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'content_scheduled_for_in_past — scheduled_for is not in the future.',
  })
  async schedule(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ScheduleContentDto,
  ): Promise<ContentPostResponseDto> {
    const kgId = requireTenant(t);
    const post = await this.service.schedule(
      kgId,
      id,
      new Date(dto.scheduled_for),
    );
    return ContentPresenter.contentPost(post);
  }

  // ── UPLOAD MEDIA (standalone) ──────────────────────────────────────────

  @Post('upload-media')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Upload a single media file. Returns URL + key for use in create/update body. Accepts image/* and video/* (≤10 MB / ≤100 MB).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiOkResponse({ type: UploadMediaResponseDto })
  @ApiBadRequestResponse({
    description: 'file_upload_error — empty file or unsupported type.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @UseInterceptors(
    FilesInterceptor('file', 1, {
      limits: { fileSize: 100 * 1024 * 1024 },
    }),
  )
  async uploadMedia(
    @Tenant() t: TenantContext,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<UploadMediaResponseDto> {
    const kgId = requireTenant(t);
    const file = files?.[0];
    if (!file) {
      throw new BadRequestException('file_required');
    }
    const result = await this.service.uploadMedia(kgId, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
    const dto = new UploadMediaResponseDto();
    dto.url = result.url;
    dto.key = result.key;
    dto.bytes = file.size;
    return dto;
  }
}
