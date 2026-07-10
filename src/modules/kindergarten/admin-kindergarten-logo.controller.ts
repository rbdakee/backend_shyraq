import {
  BadRequestException,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
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
import { KindergartenNotFoundError } from './domain/errors/kindergarten-not-found.error';
import { KindergartenLogoResponseDto } from './dto/kindergarten-response.dto';
import { KindergartenService } from './kindergarten.service';

/**
 * Admin branding-logo surface for the caller's own kindergarten (N11 —
 * BACKEND_NEEDINGS_HANDOFF). Separate controller (path `admin/kindergartens`)
 * from the read/settings `KindergartenController` (path `kindergartens`)
 * because it is multipart-only and mirrors the `admin/content` upload style.
 *
 * The stored `logo_url` is a canonical media key; the global
 * `MediaSignInterceptor` presigns it on the way out, so the POST response and
 * every subsequent `logo_url` read is a ready-to-render `<img src>` URL.
 *
 * File-shape validation (presence / `image/*` / ≤5 MB) is enforced in
 * `KindergartenService.setLogo`, surfacing clean 400 codes (`logo_required`,
 * `logo_type_invalid`, `logo_too_large`). The multer cap here is a coarse
 * upper bound so oversized bodies are rejected before buffering.
 */
@ApiTags('Kindergarten (Admin)')
@ApiBearerAuth()
@Controller({ path: 'admin/kindergartens', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class AdminKindergartenLogoController {
  constructor(private readonly service: KindergartenService) {}

  @Post('me/logo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Upload / replace the caller kindergarten branding logo.',
    description:
      'multipart/form-data, field name `file`. Accepts `image/*` ≤ 5 MB. Replaces any existing logo (best-effort deletes the previous file). Returns the presigned `logo_url`.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'Single image file in the `file` field.',
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Branding logo. `image/*` (png/jpeg/webp/…) ≤ 5 MB.',
        },
      },
    },
  })
  @ApiOkResponse({ type: KindergartenLogoResponseDto })
  @ApiBadRequestResponse({
    description:
      'logo_required (empty) / logo_type_invalid (not image/*) / logo_too_large (> 5 MB).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  @ApiNotFoundResponse({ description: 'Own kindergarten not found.' })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 }, // coarse cap; service enforces 5 MB
    }),
  )
  async uploadLogo(
    @Tenant() tenant: TenantContext,
    @UploadedFile() file?: Express.Multer.File,
  ): Promise<KindergartenLogoResponseDto> {
    if (!tenant.kgId) throw new KindergartenNotFoundError('<no-tenant>');
    if (!file) throw new BadRequestException({ code: 'logo_required' });
    const updated = await this.service.setLogo(tenant.kgId, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });
    return { logo_url: updated.logoUrl };
  }

  @Delete('me/logo')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Clear the caller kindergarten branding logo.',
    description:
      'Sets `logo_url` to null and best-effort deletes the stored file. Idempotent — a kindergarten with no logo returns `{ logo_url: null }`.',
  })
  @ApiOkResponse({ type: KindergartenLogoResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  @ApiNotFoundResponse({ description: 'Own kindergarten not found.' })
  async deleteLogo(
    @Tenant() tenant: TenantContext,
  ): Promise<KindergartenLogoResponseDto> {
    if (!tenant.kgId) throw new KindergartenNotFoundError('<no-tenant>');
    const updated = await this.service.removeLogo(tenant.kgId);
    return { logo_url: updated.logoUrl };
  }
}
