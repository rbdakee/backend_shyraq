import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { ChildService } from './child.service';
import { LinkChildDto } from './dto/link-child.dto';

/**
 * Minimal guardian acknowledgement returned on successful link. Intentionally
 * does NOT include child personal data (full_name, IIN, dob, photo, …) — the
 * primary guardian must approve before the caller may see the child via the
 * regular `/parent/children` listing. Echoing child data on the link response
 * defeats that gating and lets any authenticated caller probe IIN ↔ child
 * profile via a single 201.
 */
export class LinkChildGuardianAckDto {
  @ApiProperty({
    example: '66666666-6666-6666-6666-666666666666',
    description: 'Guardian row id (use it later to track approval state).',
  })
  id!: string;

  @ApiProperty({
    enum: ['pending_approval'],
    example: 'pending_approval',
    description: 'Always `pending_approval` for this endpoint.',
  })
  status!: 'pending_approval';

  @ApiProperty({ enum: ['secondary', 'nanny'] })
  role!: 'secondary' | 'nanny';

  @ApiProperty({ example: false })
  can_pickup!: boolean;
}

export class LinkChildResponseDto {
  @ApiProperty({ type: LinkChildGuardianAckDto })
  guardian!: LinkChildGuardianAckDto;

  @ApiProperty({
    example: true,
    description:
      'Always true. The link request was accepted; child data is hidden ' +
      'until the primary guardian approves the row.',
  })
  pending!: true;
}

/**
 * Parent link endpoint. Guards:
 *   - JwtAuthGuard         — caller must have a valid bearer token.
 *   - PendingRoleSelectGuard — blocks callers still in role-select state.
 *
 * Intentionally omits KindergartenScopeGuard and ChildAccessGuard because the
 * caller has no guardian row yet; tenant context is resolved inside the service
 * via cross-tenant IIN search.
 */
@ApiTags('Children (Parent)')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard)
export class ParentLinkController {
  constructor(private readonly service: ChildService) {}

  @Post('link')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Привязать ребёнка по ИИН (secondary | nanny).',
    description:
      'Cross-tenant lookup by IIN. Creates a pending_approval guardian row and ' +
      'notifies the approved primary guardian (if any). Primary role is reserved ' +
      'for the enrollment flow and cannot be requested here. The response only ' +
      'acknowledges the request — child data (name, IIN, dob, photo, group) ' +
      'is hidden until the primary guardian approves the link, after which the ' +
      'caller can see the child via GET /parent/children.',
  })
  @ApiCreatedResponse({
    description:
      'Guardian row created (pending_approval). Returns a minimal ack — no ' +
      'child personal data until primary approves.',
    type: LinkChildResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Validation error (e.g. iin format).' })
  @ApiUnauthorizedResponse({ description: 'invalid_token / token_revoked.' })
  @ApiForbiddenResponse({ description: 'pending_role_select.' })
  @ApiNotFoundResponse({ description: 'child_not_found_for_iin.' })
  @ApiConflictResponse({
    description:
      'multiple_children_for_iin | already_linked_to_child | already_pending_for_child.',
  })
  @ApiResponse({ status: 422, description: 'Domain validation error.' })
  @ApiTooManyRequestsResponse({
    description:
      'parent_link_rate_limit — per-user attempts on /parent/children/link ' +
      'capped at 5/hour by default to prevent IIN enumeration.',
  })
  async link(
    @CurrentUser() user: JwtPayload,
    @Body() body: LinkChildDto,
  ): Promise<LinkChildResponseDto> {
    const result = await this.service.linkChildByIin(user.sub, {
      iin: body.iin,
      role: body.role,
      canPickup: body.can_pickup,
    });
    const g = result.guardian.toState();
    return {
      guardian: {
        id: g.id,
        status: 'pending_approval',
        role: g.role as 'secondary' | 'nanny',
        can_pickup: g.canPickup,
      },
      pending: true,
    };
  }
}
