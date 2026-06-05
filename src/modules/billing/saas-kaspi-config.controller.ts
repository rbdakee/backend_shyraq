import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { SuperAdminScope } from '@/common/decorators/super-admin-scope.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import {
  KaspiGlobalConfig,
  KaspiGlobalConfigPatch,
} from './domain/kaspi-global-config';
import { KaspiGlobalConfigService } from './kaspi-global-config.service';
import { KaspiVersionProbeService } from './kaspi-version-probe.service';
import {
  KaspiGlobalConfigResponseDto,
  KaspiVersionProbeDto,
  KaspiVersionProbeResponseDto,
  UpdateKaspiGlobalConfigDto,
} from './dto/saas-kaspi-config.dto';

/**
 * SaasKaspiConfigController — super-admin surface for Kaspi global config.
 *
 * Provides three endpoints per docs/endpoints.md §1.8:
 *   GET  /saas/kaspi/config          — read current config
 *   PUT  /saas/kaspi/config          — partial update + cache invalidation
 *   POST /saas/kaspi/version-probe   — SMS-free build-gate health-check
 *
 * @SuperAdminScope() sets bypass_rls=true in the wrapping TX (the
 * kaspi_global_config table has NO RLS itself, but the decorator is required
 * for the guard to allow super_admin/support roles through without a
 * kindergarten_id in the JWT).
 */
@ApiTags('SaaS / Kaspi')
@ApiBearerAuth()
@Controller({ path: 'saas/kaspi', version: '1' })
@UseGuards(RolesGuard)
@SuperAdminScope()
@Roles('super_admin', 'support')
export class SaasKaspiConfigController {
  constructor(
    private readonly configService: KaspiGlobalConfigService,
    private readonly probeService: KaspiVersionProbeService,
  ) {}

  // ── GET /saas/kaspi/config ──────────────────────────────────────────────

  @Get('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Read the current Kaspi global config (single-row).',
    description:
      'Returns the globally-shared Kaspi app-version and URL settings. ' +
      'The super-admin updates `app_build` here when Kaspi starts rejecting ' +
      'the current build with OldVersionToUpdate.',
  })
  @ApiOkResponse({
    type: KaspiGlobalConfigResponseDto,
    description: 'Current Kaspi global config.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  async getConfig(): Promise<KaspiGlobalConfigResponseDto> {
    const cfg = await this.configService.getConfig();
    return toResponseDto(cfg);
  }

  // ── PUT /saas/kaspi/config ──────────────────────────────────────────────

  @Put('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Partially update the Kaspi global config.',
    description:
      'All body fields are optional — only supplied fields are written. ' +
      'After a successful write the in-memory cache is invalidated so all ' +
      'Kaspi adapters pick up the new values on their next request.',
  })
  @ApiOkResponse({
    type: KaspiGlobalConfigResponseDto,
    description: 'Updated Kaspi global config.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  @ApiUnprocessableEntityResponse({ description: 'Validation error (422).' })
  async updateConfig(
    @Body() body: UpdateKaspiGlobalConfigDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<KaspiGlobalConfigResponseDto> {
    const patch: KaspiGlobalConfigPatch = {};
    if (body.app_version !== undefined) patch.appVersion = body.app_version;
    if (body.app_build !== undefined) patch.appBuild = body.app_build;
    if (body.platform_ver !== undefined) patch.platformVer = body.platform_ver;
    if (body.model !== undefined) patch.model = body.model;
    if (body.brand !== undefined) patch.brand = body.brand;
    if (body.ua_native !== undefined) patch.uaNative = body.ua_native;
    if (body.ua_browser !== undefined) patch.uaBrowser = body.ua_browser;
    if (body.entrance_url !== undefined) patch.entranceUrl = body.entrance_url;
    if (body.mtoken_url !== undefined) patch.mtokenUrl = body.mtoken_url;
    if (body.qrpay_url !== undefined) patch.qrpayUrl = body.qrpay_url;

    const updated = await this.configService.update(patch, user.sub);
    return toResponseDto(updated);
  }

  // ── POST /saas/kaspi/version-probe ─────────────────────────────────────

  @Post('version-probe')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'SMS-free build-gate health-check against Kaspi entrance/step (init).',
    description:
      "Hits Kaspi's entrance/step endpoint with the given build (or the " +
      'current config build) and reports whether the gate accepted it. ' +
      'No SMS is triggered — the gate fires before phone entry. ' +
      'Use for manual binary-search of the current floor, or as a cron ' +
      'health-check (see docs/endpoints.md §1.8).',
  })
  @ApiOkResponse({
    type: KaspiVersionProbeResponseDto,
    description: 'Probe result.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  @ApiUnprocessableEntityResponse({ description: 'Validation error (422).' })
  async versionProbe(
    @Body() body: KaspiVersionProbeDto,
  ): Promise<KaspiVersionProbeResponseDto> {
    const result = await this.probeService.probe({
      appBuild: body.app_build,
      appVersion: body.app_version,
    });

    return {
      build: result.build,
      accepted: result.accepted,
      ...(result.alarm ? { alarm: result.alarm } : {}),
    };
  }
}

// ─── Presenter helper ────────────────────────────────────────────────────────

function toResponseDto(cfg: KaspiGlobalConfig): KaspiGlobalConfigResponseDto {
  const dto = new KaspiGlobalConfigResponseDto();
  dto.app_version = cfg.appVersion;
  dto.app_build = cfg.appBuild;
  dto.platform_ver = cfg.platformVer;
  dto.model = cfg.model;
  dto.brand = cfg.brand;
  dto.ua_native = cfg.uaNative;
  dto.ua_browser = cfg.uaBrowser;
  dto.entrance_url = cfg.entranceUrl;
  dto.mtoken_url = cfg.mtokenUrl;
  dto.qrpay_url = cfg.qrpayUrl;
  dto.updated_by = cfg.updatedBy;
  dto.updated_at = cfg.updatedAt;
  return dto;
}
