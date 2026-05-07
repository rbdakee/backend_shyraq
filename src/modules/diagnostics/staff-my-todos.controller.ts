import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
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
import { RolesGuard } from '@/common/guards/roles.guard';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { MyTodosQueryDto } from './dto/my-todos-query.dto';
import { MyTodosResponseDto } from './dto/my-todos-response.dto';
import { MyTodosService } from './my-todos.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Staff-app "My To-Dos" digest: children whose latest diagnostic for the
 * caller's specialist_type is older than 6 months (or absent). Admin callers
 * may pass `?specialist_type=` to inspect a specific type's backlog.
 */
@ApiTags('Staff / Diagnostics — My Todos')
@ApiBearerAuth()
@Controller({ path: 'staff/my-todos', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin', 'specialist')
export class StaffMyTodosController {
  constructor(
    private readonly service: MyTodosService,
    private readonly staffMembers: StaffMemberRepository,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      "Get list of children needing a diagnostic for the caller's specialist_type. Admin may pass ?specialist_type= to query another type.",
  })
  @ApiOkResponse({ type: MyTodosResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Role not allowed / staff_member_must_have_specialist_type (specialist without specialist_type set).',
  })
  @ApiNotFoundResponse({ description: 'staff_member_not_found.' })
  async getMyTodos(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Query() query: MyTodosQueryDto,
  ): Promise<MyTodosResponseDto> {
    const kgId = requireTenant(t);
    const isAdmin = user.role === 'admin';

    const staffMember = await this.staffMembers.findActiveByUserAndKindergarten(
      user.sub,
      kgId,
    );
    if (!staffMember) {
      throw new NotFoundException('staff_member_not_found');
    }

    const callerSpecialistType = staffMember.specialistType ?? null;
    const result = await this.service.getMyTodos(
      kgId,
      callerSpecialistType,
      query.specialist_type,
      isAdmin,
    );

    const dto = new MyTodosResponseDto();
    dto.children_needing_diagnostic = result.childrenNeedingDiagnostic.map(
      (c) => ({
        child_id: c.childId,
        child_name: c.childFullName,
        last_assessment_date: c.lastDiagnosticDate,
        days_since_last: c.daysSinceLast,
      }),
    );
    return dto;
  }
}
