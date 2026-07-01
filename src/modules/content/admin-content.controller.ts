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
  ApiBody,
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
import { SkipMediaSign } from '@/common/decorators/skip-media-sign.decorator';
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
import { FileUploadError } from './domain/errors/file-upload.error';
import { MediaTypeInvalidError } from './domain/errors/media-type-invalid.error';
import type {
  ContentTargetType,
  ContentType,
  LocalisedText,
} from './domain/entities/content-post.entity';

const TENANT_REQUIRED = 'tenant_required';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * B17 T8 MEDIUM#2 — defence-in-depth pre-buffer MIME-aware size caps.
 * The Multer `limits.fileSize` cap is set to 100 MB so video uploads pass,
 * but we want a tighter 10 MB cap for `image/*` to bound RAM use under
 * abuse (5 × 95 MB image-MIME uploads otherwise allocate ~475 MB).
 *
 * Multer's memory storage already buffered the file fully by this point,
 * but rejecting here still shields downstream code (and S3/Yandex egress
 * in Phase B). Real defense remains the controller-level interceptor
 * `limits.fileSize`; this is the per-MIME refinement.
 */
function assertFileWithinPerMimeCap(file: Express.Multer.File): void {
  const mt = (file.mimetype ?? '').toLowerCase();
  if (mt.startsWith('image/')) {
    if (file.size > MAX_IMAGE_BYTES) {
      throw new FileUploadError('file_too_large', 'image_over_10mb');
    }
    return;
  }
  if (mt.startsWith('video/')) {
    if (file.size > MAX_VIDEO_BYTES) {
      throw new FileUploadError('file_too_large', 'video_over_100mb');
    }
    return;
  }
  throw new MediaTypeInvalidError(mt);
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
  @ApiBody({
    description:
      'multipart/form-data: scalar fields as form-fields, up to 5 binary uploads in `files`. application/json: same fields, no `files`. In multipart, object fields (`title_i18n`, `body_i18n`, `metadata`) must be JSON-stringified.',
    schema: {
      type: 'object',
      required: ['content_type', 'target_type'],
      properties: {
        content_type: {
          type: 'string',
          enum: ['news', 'menu', 'schedule_pub', 'qundylyq', 'birthday'],
          example: 'news',
        },
        target_type: {
          type: 'string',
          enum: ['all', 'group', 'child'],
          example: 'all',
        },
        target_group_id: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          example: '550e8400-e29b-41d4-a716-446655440000',
        },
        target_child_id: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        },
        title: {
          type: 'string',
          maxLength: 500,
          nullable: true,
          example: 'Важное объявление',
        },
        body: {
          type: 'string',
          nullable: true,
          example: 'Просим всех родителей ознакомиться с новыми правилами.',
        },
        title_i18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          nullable: true,
          example: { ru: 'Важное объявление', kk: 'Маңызды хабарландыру' },
        },
        body_i18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          nullable: true,
          example: { ru: 'Текст', kk: 'Мәтін' },
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          nullable: true,
          example: { month: '2026-05', theme: 'Kindness' },
        },
        scheduled_for: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          example: '2026-05-10T07:00:00.000Z',
        },
        expires_at: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          example: '2026-05-17T23:59:59.000Z',
        },
        files: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string', format: 'binary' },
          description:
            'Up to 5 media files (multipart only). `image/*` ≤ 10 MB; `video/*` ≤ 100 MB per file.',
        },
      },
    },
  })
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
    for (const file of files ?? []) assertFileWithinPerMimeCap(file);
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
      'Update a content post (draft or scheduled only). Optionally attach new media files via multipart `files` field — uploaded files REPLACE existing media_urls in full. Published posts are immutable (409 content_already_published).',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    description:
      'Partial patch. multipart/form-data: scalar fields as form-fields + up to 5 binary uploads in `files` (replaces existing `media_urls` wholesale; omit `files` to leave media unchanged). application/json: same scalar fields, no `files`. In multipart, object fields must be JSON-stringified.',
    schema: {
      type: 'object',
      properties: {
        target_type: {
          type: 'string',
          enum: ['all', 'group', 'child'],
          example: 'all',
        },
        target_group_id: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          example: '550e8400-e29b-41d4-a716-446655440000',
        },
        target_child_id: {
          type: 'string',
          format: 'uuid',
          nullable: true,
          example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        },
        title: {
          type: 'string',
          maxLength: 500,
          nullable: true,
          example: 'Обновлённое объявление',
        },
        body: {
          type: 'string',
          nullable: true,
          example: 'Текст объявления изменён.',
        },
        title_i18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          nullable: true,
          example: {
            ru: 'Обновлённое объявление',
            kk: 'Жаңартылған хабарландыру',
          },
        },
        body_i18n: {
          type: 'object',
          additionalProperties: { type: 'string' },
          nullable: true,
          example: { ru: 'Текст изменён.', kk: 'Мәтін өзгерді.' },
        },
        metadata: {
          type: 'object',
          additionalProperties: true,
          nullable: true,
          example: { month: '2026-05', theme: 'Kindness' },
        },
        scheduled_for: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          example: '2026-05-10T07:00:00.000Z',
        },
        expires_at: {
          type: 'string',
          format: 'date-time',
          nullable: true,
          example: '2026-05-17T23:59:59.000Z',
        },
        files: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string', format: 'binary' },
          description:
            'Up to 5 media files (multipart only). If provided, REPLACES `media_urls` entirely. `image/*` ≤ 10 MB; `video/*` ≤ 100 MB per file. To leave media unchanged, omit this field. There is no way to remove or reorder individual existing media files via this endpoint.',
        },
      },
    },
  })
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
    for (const file of files ?? []) assertFileWithinPerMimeCap(file);
    const newMediaUrls: string[] = [];
    for (const file of files ?? []) {
      const result = await this.service.uploadMedia(kgId, {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
      });
      newMediaUrls.push(result.url);
    }

    // Spread-conditional pattern: only include keys the client actually sent,
    // so undefined DTO fields don't clobber existing values via
    // `'key' in payload` checks in the entity update method (B17 T8 HIGH#1).
    const patch: Parameters<ContentService['update']>[2] = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.body !== undefined ? { body: dto.body } : {}),
      ...(dto.title_i18n !== undefined
        ? { titleI18n: dto.title_i18n as LocalisedText | null }
        : {}),
      ...(dto.body_i18n !== undefined
        ? { bodyI18n: dto.body_i18n as LocalisedText | null }
        : {}),
      ...(dto.metadata !== undefined ? { metadata: dto.metadata } : {}),
      ...(dto.expires_at !== undefined
        ? {
            expiresAt:
              dto.expires_at !== null ? new Date(dto.expires_at) : null,
          }
        : {}),
      ...(dto.target_type !== undefined
        ? { targetType: dto.target_type as ContentTargetType }
        : {}),
      ...(dto.target_group_id !== undefined
        ? { targetGroupId: dto.target_group_id }
        : {}),
      ...(dto.target_child_id !== undefined
        ? { targetChildId: dto.target_child_id }
        : {}),
      ...(dto.scheduled_for !== undefined
        ? {
            scheduledFor:
              dto.scheduled_for !== null ? new Date(dto.scheduled_for) : null,
          }
        : {}),
    };
    if (newMediaUrls.length > 0) {
      patch.mediaUrls = newMediaUrls;
    }
    // Note: explicit `media_urls = null` path removed (B22b T9 dead-code
    // cleanup). `UpdateContentDto` has no `media_urls` field — the `in`
    // check was always false. Media URLs are only set via uploaded files.

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
  // Returns the CANONICAL `/api/v1/media/<key>` URL + key so the client can
  // persist it into a post's media_urls. Must NOT be presigned — a signed
  // (expiring) URL stored in the DB would break after the TTL.
  @SkipMediaSign()
  @ApiOperation({
    summary:
      'Upload a single media file. Returns URL + key for use in create/update body. Accepts image/* and video/* (≤10 MB / ≤100 MB).',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Single file upload. Field name is `file` (not `files`).',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'Single media file. `image/*` ≤ 10 MB; `video/*` ≤ 100 MB.',
        },
      },
    },
  })
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
    assertFileWithinPerMimeCap(file);
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
