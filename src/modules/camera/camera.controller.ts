import {
  Body,
  Controller,
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
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { CameraPresenter } from './camera.presenter';
import { CameraService } from './camera.service';
import { CameraNotFoundError } from './domain/errors/camera-not-found.error';
import { CameraDto } from './dto/camera-response.dto';
import { CameraStreamAccessDto } from './dto/camera-stream-response.dto';
import { CreateCameraDto } from './dto/create-camera.dto';
import { LinkLocationDto } from './dto/link-location.dto';
import { ListCamerasQueryDto } from './dto/list-cameras-query.dto';
import { UpdateCameraDto } from './dto/update-camera.dto';

@ApiTags('Cameras (Admin)')
@ApiBearerAuth()
@Controller({ path: 'cameras', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class CameraController {
  constructor(private readonly service: CameraService) {}

  @Get()
  @ApiOperation({ summary: 'List cameras (optionally filter by location).' })
  @ApiOkResponse({ type: [CameraDto] })
  async list(
    @Tenant() tenant: TenantContext,
    @Query() query: ListCamerasQueryDto,
  ): Promise<CameraDto[]> {
    if (!tenant.kgId) throw new CameraNotFoundError('<no-tenant>');
    const rows = await this.service.list(tenant.kgId, {
      locationId: query.location_id,
      archived: query.archived,
    });
    return rows.map((r) => CameraPresenter.camera(r));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a camera by id.' })
  @ApiOkResponse({ type: CameraDto })
  async getOne(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CameraDto> {
    if (!tenant.kgId) throw new CameraNotFoundError(id);
    const row = await this.service.getById(tenant.kgId, id);
    return CameraPresenter.camera(row);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a camera anchored to a location.' })
  @ApiOkResponse({ type: CameraDto })
  async create(
    @Tenant() tenant: TenantContext,
    @Body() dto: CreateCameraDto,
  ): Promise<CameraDto> {
    if (!tenant.kgId) throw new CameraNotFoundError('<no-tenant>');
    const row = await this.service.create(tenant.kgId, {
      locationId: dto.location_id,
      name: dto.name,
      rtspUrl: dto.rtsp_url,
      hlsUrl: dto.hls_url ?? null,
      streamKey: dto.stream_key ?? null,
      streamKeyHd: dto.stream_key_hd ?? null,
    });
    return CameraPresenter.camera(row);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a camera (partial).' })
  @ApiOkResponse({ type: CameraDto })
  async update(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateCameraDto,
  ): Promise<CameraDto> {
    if (!tenant.kgId) throw new CameraNotFoundError(id);
    const patch: Parameters<CameraService['update']>[2] = {};
    if (dto.location_id !== undefined) patch.locationId = dto.location_id;
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.rtsp_url !== undefined) patch.rtspUrl = dto.rtsp_url;
    if (Object.prototype.hasOwnProperty.call(dto, 'hls_url')) {
      patch.hlsUrl = dto.hls_url ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'stream_key')) {
      patch.streamKey = dto.stream_key ?? null;
    }
    if (Object.prototype.hasOwnProperty.call(dto, 'stream_key_hd')) {
      patch.streamKeyHd = dto.stream_key_hd ?? null;
    }
    const row = await this.service.update(tenant.kgId, id, patch);
    return CameraPresenter.camera(row);
  }

  @Post(':id/link-location')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Re-link camera to a different location.' })
  @ApiOkResponse({ type: CameraDto })
  async linkLocation(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: LinkLocationDto,
  ): Promise<CameraDto> {
    if (!tenant.kgId) throw new CameraNotFoundError(id);
    const row = await this.service.linkToLocation(
      tenant.kgId,
      id,
      dto.location_id,
    );
    return CameraPresenter.camera(row);
  }

  @Get(':id/stream')
  @ApiOperation({
    summary: 'Playable URLs for this camera, for the admin panel viewer.',
    description:
      'Mints a short-lived stream token for the calling admin. Admins are not guardians, so they cannot use the parent route; the tenant-scoped lookup here is the authorisation. `streams` is empty (not an error) when the camera is archived or not bound to the media gateway.',
  })
  @ApiOkResponse({ type: CameraStreamAccessDto })
  async stream(
    @Tenant() tenant: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CameraStreamAccessDto> {
    if (!tenant.kgId) throw new CameraNotFoundError(id);
    const access = await this.service.streamAccess(tenant.kgId, id, user.sub);
    return CameraPresenter.streamAccess(access);
  }

  @Post(':id/refresh-codec')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-probe the camera and store the codec it currently emits.',
    description:
      'Asks the media gateway what is on the wire right now. The periodic probe does this on its own; this endpoint is for when an installer has just switched a camera and nobody wants to wait for the next tick. A camera with no stream key, or one the gateway cannot reach, comes back unchanged rather than erroring — the stale codec_checked_at is the signal.',
  })
  @ApiOkResponse({ type: CameraDto })
  async refreshCodec(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CameraDto> {
    if (!tenant.kgId) throw new CameraNotFoundError(id);
    const row = await this.service.refreshCodec(tenant.kgId, id);
    return CameraPresenter.camera(row);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a camera (idempotent).' })
  @ApiOkResponse({ type: CameraDto })
  async archive(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CameraDto> {
    if (!tenant.kgId) throw new CameraNotFoundError(id);
    const row = await this.service.archive(tenant.kgId, id);
    return CameraPresenter.camera(row);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived camera (idempotent).' })
  @ApiOkResponse({ type: CameraDto })
  async restore(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CameraDto> {
    if (!tenant.kgId) throw new CameraNotFoundError(id);
    const row = await this.service.restore(tenant.kgId, id);
    return CameraPresenter.camera(row);
  }
}
