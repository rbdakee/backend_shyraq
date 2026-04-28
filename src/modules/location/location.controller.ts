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
import { CreateLocationDto } from './dto/create-location.dto';
import { ListLocationsQueryDto } from './dto/list-locations-query.dto';
import { LocationDto } from './dto/location-response.dto';
import { UpdateLocationDto } from './dto/update-location.dto';
import { LocationNotFoundError } from './domain/errors/location-not-found.error';
import { LocationPresenter } from './location.presenter';
import { LocationService } from './location.service';

@ApiTags('Locations (Admin)')
@ApiBearerAuth()
@Controller({ path: 'locations', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class LocationController {
  constructor(private readonly service: LocationService) {}

  @Get()
  @ApiOperation({ summary: 'List locations.' })
  @ApiOkResponse({ type: [LocationDto] })
  async list(
    @Tenant() tenant: TenantContext,
    @Query() query: ListLocationsQueryDto,
  ): Promise<LocationDto[]> {
    if (!tenant.kgId) throw new LocationNotFoundError('<no-tenant>');
    const rows = await this.service.list(tenant.kgId, {
      archived: query.archived,
    });
    return rows.map((r) => LocationPresenter.location(r));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a location by id.' })
  @ApiOkResponse({ type: LocationDto })
  async getOne(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LocationDto> {
    if (!tenant.kgId) throw new LocationNotFoundError(id);
    const row = await this.service.getById(tenant.kgId, id);
    return LocationPresenter.location(row);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a location.' })
  @ApiOkResponse({ type: LocationDto })
  async create(
    @Tenant() tenant: TenantContext,
    @Body() dto: CreateLocationDto,
  ): Promise<LocationDto> {
    if (!tenant.kgId) throw new LocationNotFoundError('<no-tenant>');
    const row = await this.service.create(tenant.kgId, {
      name: dto.name,
      description: dto.description ?? null,
    });
    return LocationPresenter.location(row);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a location (partial).' })
  @ApiOkResponse({ type: LocationDto })
  async update(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateLocationDto,
  ): Promise<LocationDto> {
    if (!tenant.kgId) throw new LocationNotFoundError(id);
    const patch: Parameters<LocationService['update']>[2] = {};
    if (dto.name !== undefined) patch.name = dto.name;
    if (Object.prototype.hasOwnProperty.call(dto, 'description')) {
      patch.description = dto.description ?? null;
    }
    const row = await this.service.update(tenant.kgId, id, patch);
    return LocationPresenter.location(row);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a location (idempotent).' })
  @ApiOkResponse({ type: LocationDto })
  async archive(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LocationDto> {
    if (!tenant.kgId) throw new LocationNotFoundError(id);
    const row = await this.service.archive(tenant.kgId, id);
    return LocationPresenter.location(row);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Restore an archived location (idempotent).' })
  @ApiOkResponse({ type: LocationDto })
  async restore(
    @Tenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<LocationDto> {
    if (!tenant.kgId) throw new LocationNotFoundError(id);
    const row = await this.service.restore(tenant.kgId, id);
    return LocationPresenter.location(row);
  }
}
