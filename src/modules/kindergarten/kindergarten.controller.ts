import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
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
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { KindergartenDto } from './dto/kindergarten-response.dto';
import { KindergartenPresenter } from './kindergarten.presenter';
import { KindergartenService } from './kindergarten.service';

/**
 * Admin-scoped kindergarten endpoints. The handler runs inside the
 * TenantContextInterceptor's request transaction with `SET LOCAL
 * app.kindergarten_id` already pinned to the JWT's tenant — RLS therefore
 * shields cross-tenant access at the database layer too.
 */
@ApiTags('Kindergarten (Admin)')
@ApiBearerAuth()
@Controller({ path: 'kindergartens', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class KindergartenController {
  constructor(private readonly service: KindergartenService) {}

  @Get('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get the caller’s own kindergarten.',
    description:
      'Resolved from the JWT `kindergarten_id` claim. RLS additionally enforces tenant scope at the DB layer.',
  })
  @ApiOkResponse({ type: KindergartenDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  @ApiNotFoundResponse({
    description: 'Kindergarten not found (archived / mis-tenant).',
  })
  async getMine(@Tenant() tenant: TenantContext): Promise<KindergartenDto> {
    if (!tenant.kgId) throw new KindergartenNotFoundError('<no-tenant>');
    const kg = await this.service.getMyKindergarten(tenant.kgId);
    return KindergartenPresenter.kindergarten(kg);
  }

  @Patch('me/settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace own kindergarten settings (non-fiscal keys only).',
    description:
      'Whole-bag replacement. Any `fiscal_*` key triggers HTTP 403 `fiscal_settings_forbidden` — those keys live behind the SuperAdmin surface.',
  })
  @ApiBody({
    type: UpdateSettingsDto,
    examples: {
      basic: {
        summary: 'Timezone + currency',
        value: { settings: { timezone: 'Asia/Almaty', currency: 'KZT' } },
      },
      withLateFee: {
        summary: 'Add late-pickup fee',
        value: {
          settings: {
            timezone: 'Asia/Almaty',
            currency: 'KZT',
            late_pickup_fee_amount: 500,
          },
        },
      },
    },
  })
  @ApiOkResponse({ type: KindergartenDto })
  @ApiBadRequestResponse({ description: 'Validation failed.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an admin OR the body contains a fiscal_* key (`fiscal_settings_forbidden`).',
  })
  @ApiNotFoundResponse({ description: 'Own kindergarten not found.' })
  async updateMySettings(
    @Tenant() tenant: TenantContext,
    @Body() dto: UpdateSettingsDto,
  ): Promise<KindergartenDto> {
    if (!tenant.kgId) throw new KindergartenNotFoundError('<no-tenant>');
    const updated = await this.service.updateSettings(tenant.kgId, {
      settings: dto.settings,
      allowFiscalKeys: false,
    });
    return KindergartenPresenter.kindergarten(updated);
  }
}
