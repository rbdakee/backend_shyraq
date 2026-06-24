import {
  BadRequestException,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import { SkipMediaSign } from '@/common/decorators/skip-media-sign.decorator';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ContentService } from './content.service';
import { UploadMediaResponseDto } from './dto/responses/upload-media-response.dto';

const TENANT_REQUIRED = 'tenant_required';

// BR-012 — staff media upload accepts ONLY images (jpeg/png/webp) ≤ 10 MB.
// The timeline (M-06), progress-notes (M-12) and diagnostics (SP-03) screens
// attach photos via this generic endpoint; video is intentionally out of scope.
const STAFF_MEDIA_ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const STAFF_MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * BR-012 — generic staff media upload (`POST /api/v1/staff/media`).
 *
 * Thin wrapper over {@link ContentService.uploadMedia} (the same method that
 * backs `POST /admin/content/upload-media`). Returns the CANONICAL
 * `/api/v1/media/<key>` URL + key so the client can persist it into a record's
 * media field at create/patch time. The kg-scoped key shape
 * (`<kgId>/<yyyy-mm>/<uuid>.<ext>`) matches the readable `GET /api/v1/media/...`
 * route, where the global `MediaSignInterceptor` presigns it on read.
 *
 * Marked `@SkipMediaSign()` so the upload response is NOT presigned — a signed
 * (expiring) URL stored in the DB would break after the TTL.
 *
 * Roles: `mentor`, `specialist`, `reception`, `admin` (the staff who attach
 * media to timeline/progress-note/diagnostic records). The global
 * `JwtAuthGuard` + `KindergartenScopeGuard` + `PendingRoleSelectGuard` run
 * first (app.module.ts); `RolesGuard` enforces the role gate on top.
 */
@ApiTags('Staff / Media')
@ApiBearerAuth()
@Controller({ path: 'staff/media', version: '1' })
@UseGuards(RolesGuard)
@Roles('mentor', 'specialist', 'reception', 'admin')
export class StaffMediaController {
  constructor(private readonly content: ContentService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  // Returns the CANONICAL `/api/v1/media/<key>` URL — must NOT be presigned.
  @SkipMediaSign()
  @ApiOperation({
    summary:
      'Upload a single staff media image (jpeg/png/webp ≤ 10 MB). Returns canonical url + key + bytes for use in timeline/progress-note/diagnostic record fields.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Single image upload. Field name is `file`.',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Single image file. `image/jpeg|png|webp` ≤ 10 MB.',
        },
      },
    },
  })
  @ApiOkResponse({ type: UploadMediaResponseDto })
  @ApiBadRequestResponse({
    description: 'media_file_required / media_type_invalid / media_too_large.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not mentor/specialist/reception/admin.',
  })
  @UseInterceptors(
    FilesInterceptor('file', 1, {
      limits: { fileSize: STAFF_MEDIA_MAX_BYTES },
    }),
  )
  async upload(
    @Tenant() t: TenantContext,
    @UploadedFiles() files?: Express.Multer.File[],
  ): Promise<UploadMediaResponseDto> {
    const kgId = requireTenant(t);
    const file = files?.[0];
    if (!file) {
      throw new BadRequestException('media_file_required');
    }
    if (!STAFF_MEDIA_ALLOWED.includes((file.mimetype ?? '').toLowerCase())) {
      throw new BadRequestException('media_type_invalid');
    }
    if (file.size > STAFF_MEDIA_MAX_BYTES) {
      throw new BadRequestException('media_too_large');
    }
    const result = await this.content.uploadMedia(kgId, {
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
