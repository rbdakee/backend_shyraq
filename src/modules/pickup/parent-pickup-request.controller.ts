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
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { CreatePickupRequestDto } from './dto/create-pickup-request.dto';
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
 * check-out via Staff App. The body's `child_id` must match the URL
 * `:id` param to keep the contract symmetric with the staff endpoint.
 */
@ApiTags('Parent / Pickup')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('parent')
export class ParentPickupRequestController {
  constructor(private readonly service: PickupRequestService) {}

  @Post(':id/pickup-requests')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Parent initiates a pickup_request for the child. Either bound to an existing trusted_people row or ad-hoc.',
  })
  @ApiCreatedResponse({ type: PickupRequestResponseDto })
  @ApiBadRequestResponse({
    description:
      'Validation error OR body.child_id mismatches URL :id (`child_id_mismatch`).',
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
    @Body() dto: CreatePickupRequestDto,
  ): Promise<PickupRequestResponseDto> {
    const kgId = requireTenant(t);
    if (dto.childId !== childId) {
      throw new BadRequestException('child_id_mismatch');
    }
    const pr = await this.service.createByParent(kgId, user.sub, {
      childId,
      trustedPersonId: dto.trustedPersonId ?? null,
      trustedPersonName: dto.trustedPersonName,
      trustedPersonPhone: dto.trustedPersonPhone,
      trustedPersonIin: dto.trustedPersonIin ?? null,
    });
    return PickupPresenter.pickupRequest(pr);
  }
}
