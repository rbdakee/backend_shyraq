import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ChildPresenter } from './child.presenter';
import { ChildService } from './child.service';
import { ChildDto, GuardianDto } from './dto';

/**
 * Parent-scoped read endpoints. Wrapped with `ChildAccessGuard` so that any
 * route exposing `:childId` rejects callers who are not approved guardians of
 * that child. Listing-only endpoints (`/me`) skip the per-row guard and let
 * the service layer scope the result set to the calling user's approved
 * guardian rows.
 */
@ApiTags('Children (Parent)')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, ChildAccessGuard)
export class ParentChildController {
  constructor(private readonly service: ChildService) {}

  @Get()
  @ApiOperation({
    summary:
      'List children where the caller is an approved guardian (any role).',
  })
  @ApiOkResponse({ type: [ChildDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller has no approved guardian record in this tenant.',
  })
  async listMine(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
  ): Promise<ChildDto[]> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const rows = await this.service.listMyChildren(t.kgId, user.sub);
    return rows.map((c) => ChildPresenter.child(c));
  }

  @Get(':id')
  @ApiOperation({
    summary:
      'Get the child card. Available only to approved guardians of the child (ChildAccessGuard).',
  })
  @ApiOkResponse({
    schema: {
      properties: {
        child: { $ref: '#/components/schemas/ChildDto' },
        guardians: {
          type: 'array',
          items: { $ref: '#/components/schemas/GuardianDto' },
        },
      },
    },
  })
  @ApiForbiddenResponse({
    description: 'Caller is not an approved guardian of this child.',
  })
  async getOne(
    @Tenant() t: TenantContext,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ child: ChildDto; guardians: GuardianDto[] }> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const out = await this.service.getChild(t.kgId, id);
    return {
      child: ChildPresenter.child(out.child),
      guardians: out.guardians.map((g) => ChildPresenter.guardian(g)),
    };
  }
}
