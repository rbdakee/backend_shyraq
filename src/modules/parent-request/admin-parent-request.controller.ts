import {
  BadRequestException,
  Controller,
  Get,
  Query,
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
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ListParentRequestsQueryDto } from './dto/list-parent-requests-query.dto';
import { ParentRequestListResponseDto } from './dto/parent-request.response.dto';
import { ParentRequestPresenter } from './parent-request.presenter';
import { ParentRequestService } from './parent-request.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Admin-only parent_requests view (B12). Provides an unfiltered listing of
 * every parent_request in the kg — for the admin overview UI. The
 * accept/reject/messages CRUD lives on the staff controller (admin role
 * is allowed there too).
 */
@ApiTags('Admin / Parent Requests')
@ApiBearerAuth()
@Controller({ path: 'admin/parent-requests', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class AdminParentRequestController {
  constructor(private readonly service: ParentRequestService) {}

  @Get()
  @ApiOperation({
    summary:
      'List every parent_request in the kg. Filters: status, type, child_id, recipient_type. Cursor paginated.',
  })
  @ApiOkResponse({ type: ParentRequestListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Admin role required.' })
  async list(
    @Tenant() t: TenantContext,
    @Query() q: ListParentRequestsQueryDto,
  ): Promise<ParentRequestListResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.listAllForAdmin(kgId, {
      status: q.status,
      type: q.type,
      childId: q.child_id,
      groupId: q.group_id,
      recipientType: q.recipient_type,
      limit: q.limit,
      cursor: q.cursor ?? null,
    });
    const staffNames = await this.service.resolveRequestStaffNames(
      kgId,
      result.items,
    );
    return ParentRequestPresenter.list(
      result.items,
      result.nextCursor,
      staffNames,
    );
  }
}
