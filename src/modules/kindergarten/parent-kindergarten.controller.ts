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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ParentKindergartenDto } from './dto/parent-kindergarten-response.dto';
import { KindergartenPresenter } from './kindergarten.presenter';
import { KindergartenService } from './kindergarten.service';

/**
 * Parent read-only access to the kindergarten their child attends.
 *
 *   GET /api/v1/parent/children/:childId/kindergarten
 *
 * Tenant is derived from the RESOURCE (the child), not the JWT: the parent
 * token carries `kindergarten_id: null` by design for multi-kg parents, so
 * `ChildAccessGuard` resolves the child cross-tenant, admits an approved
 * guardian, and pins `req.tenant.kgId` to the child's kindergarten. Only then
 * does the service load that kindergarten under the RLS-scoped transaction.
 * `RolesGuard` + `@Roles('parent')` keep this surface parent-only; the guard
 * passes non-parent roles straight through (handled by other controllers).
 *
 * `JwtAuthGuard` / `PendingRoleSelectGuard` / `TenantContextInterceptor` are
 * applied globally (see `app.module.ts`), so they are not re-listed here —
 * mirrors `ParentDiagnosticController`.
 */
@ApiTags('Kindergarten (Parent)')
@ApiBearerAuth()
@Controller({ path: 'parent/children/:childId', version: '1' })
@UseGuards(ChildAccessGuard, RolesGuard)
@Roles('parent')
export class ParentKindergartenController {
  constructor(private readonly service: KindergartenService) {}

  @Get('kindergarten')
  @ApiOperation({
    summary:
      'Get the kindergarten the child attends (name / address / phone). ' +
      'Available only to approved guardians of the child (ChildAccessGuard); ' +
      'tenant is derived from the child, so it works for multi-kg parents.',
  })
  @ApiOkResponse({ type: ParentKindergartenDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'Caller is not an approved guardian of this child.',
  })
  @ApiNotFoundResponse({ description: 'kindergarten_not_found.' })
  async getKindergarten(
    @Tenant() t: TenantContext,
    // Parsed for validation only — the authoritative tenant is pinned by
    // ChildAccessGuard onto `t.kgId`; the child id itself is not needed here.
    @Param('childId', new ParseUUIDPipe()) _childId: string,
  ): Promise<ParentKindergartenDto> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const kg = await this.service.getMyKindergarten(t.kgId);
    return KindergartenPresenter.parent(kg);
  }
}
