import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { AuthenticatedRequest } from '@/common/types/authenticated-request';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { CameraNotFoundError } from './domain/errors/camera-not-found.error';
import { CctvAccessDto } from './dto/parent-cctv-response.dto';
import { ParentCctvPresenter } from './parent-cctv.presenter';
import { ParentCctvService } from './parent-cctv.service';

/**
 * Parent-facing CCTV access.
 *
 * `ChildAccessGuard` proves the caller is an approved guardian of the child
 * and pins the tenant to that child's kindergarten; the service then checks
 * the `view_cctv` permission, which nannies do not hold by default.
 */
@ApiTags('CCTV (Parent)')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, ChildAccessGuard)
export class ParentCctvController {
  constructor(private readonly service: ParentCctvService) {}

  @Get(':childId/cctv')
  @ApiOperation({
    summary: 'Cameras the parent may watch for this child right now.',
    description:
      'Resolves child → current group → the location that group is in at this moment → cameras anchored there. The answer changes when a mentor moves the group, so re-request on the group location-changed event rather than caching.',
  })
  @ApiOkResponse({ type: CctvAccessDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      '`child_access_denied` — not an approved guardian. `cctv_access_denied` — guardian without the view_cctv permission (nanny by default).',
  })
  @ApiNotFoundResponse({ description: '`child_not_found` in this tenant.' })
  @ApiServiceUnavailableResponse({
    description:
      '`cctv_not_configured` — the streaming host or signing key is not set up in this environment.',
  })
  async list(
    @Tenant() tenant: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Req() req: AuthenticatedRequest,
    @Param('childId', new ParseUUIDPipe()) childId: string,
  ): Promise<CctvAccessDto> {
    if (!tenant.kgId) throw new CameraNotFoundError('<no-tenant>');
    if (!this.service.isConfigured) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        error: 'cctv_not_configured',
        message: 'cctv_not_configured',
      });
    }
    const view = await this.service.listForChild(
      tenant.kgId,
      childId,
      user.sub,
      req.guardianRecord,
    );
    return ParentCctvPresenter.access(view);
  }
}
