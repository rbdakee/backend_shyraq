import {
  Controller,
  ForbiddenException,
  Get,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import { FileStorageNotFoundError } from './domain/errors/file-upload.error';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';

const EXT_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const YYYY_MM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const FILENAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;

/**
 * Authenticated media route — replaces public `/static/*` served via
 * `ServeStaticModule` (closes FINDINGS.md SP5).
 *
 * Files are stored at `<uploadsDir>/<kgId>/<yyyy-mm>/<uuid>.<ext>` and were
 * previously addressable at `/static/<kgId>/<yyyy-mm>/<uuid>.<ext>` with NO
 * auth — Express `serve-static` bypasses NestJS guards entirely. Anyone with
 * the URL (which leaks via push payload + brute-force enumeration of the kg
 * UUID + month + UUID4 file name) could fetch tenant media.
 *
 * This controller serves the same key under `/api/v1/media/...` BUT:
 *   - JwtAuthGuard (global) requires a valid bearer token
 *   - KindergartenScopeGuard (global) populates `req.tenant`
 *   - Path-segment `kgId` must equal the caller's `tenant.kgId`, unless the
 *     caller is super-admin (`tenant.bypass === true`)
 *   - Path validation rejects `..`, absolute paths, weird filenames before
 *     hitting the FileStoragePort
 *
 * The producing adapter (LocalFileStorageAdapter) now emits URLs under the
 * new prefix so all references in `content_posts.media_urls` and
 * `group_stories.media_urls` route through this controller.
 */
@ApiTags('Media')
@ApiBearerAuth()
@Controller({ path: 'media', version: '1' })
export class MediaController {
  constructor(
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
  ) {}

  @Get(':kgId/:yyyyMm/:filename')
  @ApiOperation({
    summary:
      'Stream uploaded media (story / content post). Auth required + caller-kg-scoped.',
  })
  @ApiParam({ name: 'kgId', description: 'Kindergarten UUID owning the file.' })
  @ApiParam({
    name: 'yyyyMm',
    description: 'Year-month subdir, e.g. 2026-05.',
    example: '2026-05',
  })
  @ApiParam({
    name: 'filename',
    description: 'UUID + extension, e.g. <uuid>.jpg.',
  })
  @ApiOkResponse({
    description: 'Raw media bytes streamed with appropriate Content-Type.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller kg does not match path kg (cross-tenant attempt).',
  })
  @ApiNotFoundResponse({ description: 'File not found.' })
  async stream(
    @Tenant() tenant: TenantContext,
    @Param('kgId') kgId: string,
    @Param('yyyyMm') yyyyMm: string,
    @Param('filename') filename: string,
    @Res() res: Response,
  ): Promise<void> {
    // Path-shape validation BEFORE storage — keeps malicious shapes out of
    // the adapter's path-traversal guard (defence-in-depth).
    if (!UUID_RE.test(kgId)) {
      throw new NotFoundException({ code: 'media_not_found' });
    }
    if (!YYYY_MM_RE.test(yyyyMm)) {
      throw new NotFoundException({ code: 'media_not_found' });
    }
    if (!FILENAME_RE.test(filename)) {
      throw new NotFoundException({ code: 'media_not_found' });
    }

    // Tenant gate. Super-admin (bypass=true) sees every kg's media.
    if (!tenant.bypass && tenant.kgId !== kgId) {
      throw new ForbiddenException({ code: 'media_cross_tenant_denied' });
    }

    const key = `${kgId}/${yyyyMm}/${filename}`;
    let buffer: Buffer;
    try {
      buffer = await this.storage.download(key);
    } catch (err) {
      // B22b T9 — adapter now throws FileStorageNotFoundError for ENOENT;
      // keep the raw ENOENT fallback for adapters that have not yet been
      // updated (e.g. future S3 Phase-B adapter before it adopts the
      // discriminated error hierarchy).
      if (
        err instanceof FileStorageNotFoundError ||
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new NotFoundException({ code: 'media_not_found' });
      }
      throw err;
    }

    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    const contentType = EXT_TO_MIME[ext] ?? 'application/octet-stream';

    res
      .status(HttpStatus.OK)
      .setHeader('Content-Type', contentType)
      .setHeader('Content-Length', String(buffer.length))
      // No-cache so revoking a guardian or expiring a story immediately
      // stops a previously-pushed URL from rendering on the client side.
      .setHeader('Cache-Control', 'private, no-store')
      .send(buffer);
  }
}
