import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { Roles } from '@/common/decorators/roles.decorator';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ParentCreatePickupRequestDto } from './dto/create-pickup-request.dto';
import { PickupRequestResponseDto } from './dto/pickup-request-response.dto';
import { PickupPresenter } from './pickup.presenter';
import { PickupRequestService } from './pickup-request.service';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Parent-initiated pickup-request endpoint (B11).
 *
 *   POST /parent/children/:id/pickup-requests
 *
 * The parent must have an approved-active guardian link with
 * `can_pickup=true` for the child — same precondition as a direct
 * check-out via Staff App. `child_id` is taken from the URL `:id`
 * path param (NOT the body) — the parent DTO does not declare it.
 */
@ApiTags('Parent / Pickup')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('parent')
export class ParentPickupRequestController {
  constructor(private readonly service: PickupRequestService) {}

  @Post(':id/pickup-requests')
  @UseGuards(ChildAccessGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Parent initiates a pickup_request for the child. Either bound to an existing trusted_people row or ad-hoc.',
  })
  @ApiCreatedResponse({ type: PickupRequestResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not an approved-active pickup-guardian for this child (`parent_not_authorized_for_pickup`).',
  })
  @ApiNotFoundResponse({
    description: 'child_not_found / trusted_person_not_found.',
  })
  @ApiGoneResponse({ description: 'trusted_person_revoked.' })
  @ApiUnprocessableEntityResponse({
    description: 'Domain invariant violation.',
  })
  async create(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) childId: string,
    @Body() dto: ParentCreatePickupRequestDto,
  ): Promise<PickupRequestResponseDto> {
    const kgId = requireTenant(t);
    const pr = await this.service.createByParent(kgId, user.sub, {
      childId,
      trustedPersonId: dto.trusted_person_id ?? null,
      trustedPersonName: dto.trusted_person_name,
      trustedPersonPhone: dto.trusted_person_phone,
      trustedPersonIin: dto.trusted_person_iin ?? null,
    });
    return PickupPresenter.pickupRequest(pr);
  }
}
