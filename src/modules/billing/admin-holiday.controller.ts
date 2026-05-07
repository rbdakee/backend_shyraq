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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import {
  CreateHolidayDto,
  HolidayResponseDto,
  ListHolidaysQueryDto,
  UpdateHolidayDto,
} from './dto/holiday.dto';
import { HolidayPresenter } from './holiday.presenter';
import { HolidayService } from './holiday.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin CRUD over the per-kindergarten holiday calendar. Used by
 * `InvoiceService` for pro-rata discount calculation in monthly billing —
 * non-billable holidays reduce the effective billable-day count.
 */
@ApiTags('Admin / Billing — Holidays')
@ApiBearerAuth()
@Controller({ path: 'admin/holidays', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminHolidayController {
  constructor(private readonly service: HolidayService) {}

  @Get()
  @ApiOperation({
    summary: 'List holidays (filters: from_date, to_date, is_billable).',
  })
  @ApiOkResponse({ type: [HolidayResponseDto] })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListHolidaysQueryDto,
  ): Promise<HolidayResponseDto[]> {
    const kgId = requireTenant(t);
    const holidays = await this.service.list(kgId, {
      fromDate: query.from_date,
      toDate: query.to_date,
      isBillable: query.is_billable,
    });
    return HolidayPresenter.many(holidays);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a holiday entry.' })
  @ApiCreatedResponse({ type: HolidayResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiConflictResponse({
    description: 'Holiday already exists for this date in this kindergarten.',
  })
  async create(
    @Tenant() t: TenantContext,
    @Body() dto: CreateHolidayDto,
  ): Promise<HolidayResponseDto> {
    const kgId = requireTenant(t);
    const holiday = await this.service.create(kgId, {
      date: new Date(dto.date),
      name: dto.name as unknown as Record<string, string>,
      isBillable: dto.is_billable,
    });
    return HolidayPresenter.one(holiday);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a holiday by id.' })
  @ApiOkResponse({ type: HolidayResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Holiday not found.' })
  async get(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<HolidayResponseDto> {
    const kgId = requireTenant(t);
    const holiday = await this.service.get(kgId, id);
    return HolidayPresenter.one(holiday);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a holiday (partial — name, is_billable).' })
  @ApiOkResponse({ type: HolidayResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Holiday not found.' })
  async update(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateHolidayDto,
  ): Promise<HolidayResponseDto> {
    const kgId = requireTenant(t);
    const holiday = await this.service.update(kgId, id, {
      name: dto.name,
      isBillable: dto.is_billable,
    });
    return HolidayPresenter.one(holiday);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a holiday entry.' })
  @ApiNoContentResponse({ description: 'Holiday deleted.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiNotFoundResponse({ description: 'Holiday not found.' })
  async delete(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    const kgId = requireTenant(t);
    await this.service.delete(kgId, id);
  }
}
