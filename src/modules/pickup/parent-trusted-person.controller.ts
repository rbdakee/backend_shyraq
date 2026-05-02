import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { AddTrustedPersonDto } from './dto/add-trusted-person.dto';
import { TrustedPersonResponseDto } from './dto/trusted-person-response.dto';
import { UpdateTrustedPersonDto } from './dto/update-trusted-person.dto';
import { PickupPresenter } from './pickup.presenter';
import { TrustedPersonService } from './trusted-person.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Parent-side CRUD over the `trusted_people` whitelist (B11).
 *
 *   GET    /parent/children/:id/trusted-people
 *   POST   /parent/children/:id/trusted-people
 *   PATCH  /parent/trusted-people/:id
 *   POST   /parent/trusted-people/:id/revoke
 *
 * Authorization: parent must be an approved-active guardian on the child
 * for list/add. For PATCH/revoke, the caller must either have added the
 * row themselves or be an approved-active guardian on the same child.
 *
 * No `ChildAccessGuard` is used because the trusted-people endpoints are
 * keyed by `trusted_person.id` for PATCH/revoke (the guard expects a
 * child id in the URL). The service-level checks cover the same intent.
 */
@ApiTags('Parent / Trusted People')
@ApiBearerAuth()
@Controller({ path: 'parent', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('parent')
export class ParentTrustedPersonController {
  constructor(private readonly service: TrustedPersonService) {}

  @Get('children/:id/trusted-people')
  @ApiOperation({
    summary:
      "Parent view of the child's trusted-people whitelist. Includes both active and revoked rows so the client can render historical state.",
  })
  @ApiOkResponse({ type: [TrustedPersonResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an approved-active guardian for this child (`parent_not_a_guardian` / `parent_guardian_not_approved`).',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async list(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) childId: string,
  ): Promise<TrustedPersonResponseDto[]> {
    const kgId = requireTenant(t);
    const items = await this.service.listByChild(kgId, childId, user.sub);
    return items.map((tp) => PickupPresenter.trustedPerson(tp));
  }

  @Post('children/:id/trusted-people')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Add a new trusted_people row for the child. The caller must be an approved-active guardian for the child.',
  })
  @ApiCreatedResponse({ type: TrustedPersonResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an approved-active guardian for this child.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async add(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) childId: string,
    @Body() dto: AddTrustedPersonDto,
  ): Promise<TrustedPersonResponseDto> {
    const kgId = requireTenant(t);
    const tp = await this.service.addByParent(kgId, childId, user.sub, {
      fullName: dto.full_name,
      phone: dto.phone,
      iin: dto.iin ?? null,
      relation: dto.relation,
      photoUrl: dto.photo_url ?? null,
      isOneTime: dto.is_one_time ?? false,
    });
    return PickupPresenter.trustedPerson(tp);
  }

  @Patch('trusted-people/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Patch a trusted_people row. Only the original adder OR an approved-active guardian on the same child may update.',
  })
  @ApiOkResponse({ type: TrustedPersonResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller cannot manage this row.' })
  @ApiNotFoundResponse({ description: 'trusted_person_not_found.' })
  async update(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) trustedPersonId: string,
    @Body() dto: UpdateTrustedPersonDto,
  ): Promise<TrustedPersonResponseDto> {
    const kgId = requireTenant(t);
    const tp = await this.service.update(kgId, trustedPersonId, user.sub, {
      fullName: dto.full_name,
      phone: dto.phone,
      iin: dto.iin,
      relation: dto.relation,
      photoUrl: dto.photo_url,
      isOneTime: dto.is_one_time,
    });
    return PickupPresenter.trustedPerson(tp);
  }

  @Post('trusted-people/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Revoke a trusted_people row. Stamps `revoked_at = now()` and flips `is_active = false`. Idempotent at the SQL layer; surfaces a domain error on a second attempt.',
  })
  @ApiOkResponse({ type: TrustedPersonResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller cannot manage this row.' })
  @ApiNotFoundResponse({ description: 'trusted_person_not_found.' })
  async revoke(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) trustedPersonId: string,
  ): Promise<TrustedPersonResponseDto> {
    const kgId = requireTenant(t);
    const tp = await this.service.revoke(kgId, trustedPersonId, user.sub);
    return PickupPresenter.trustedPerson(tp);
  }
}
