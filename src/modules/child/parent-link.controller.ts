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
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import type { JwtPayload } from '@/common/types/jwt-payload';
import { ChildPresenter } from './child.presenter';
import { ChildService } from './child.service';
import { ChildDto, GuardianDto } from './dto';
import { LinkChildDto } from './dto/link-child.dto';

export class LinkChildResponseDto {
  guardian!: GuardianDto;
  child!: ChildDto;
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
      'for the enrollment flow and cannot be requested here.',
  })
  @ApiCreatedResponse({
    description:
      'Guardian row created (pending_approval). Returns guardian + child.',
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
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async link(
    @CurrentUser() user: JwtPayload,
    @Body() body: LinkChildDto,
  ): Promise<LinkChildResponseDto> {
    const result = await this.service.linkChildByIin(user.sub, {
      iin: body.iin,
      role: body.role,
      canPickup: body.can_pickup,
    });
    return {
      guardian: ChildPresenter.guardian(result.guardian),
      child: ChildPresenter.child(result.child),
    };
  }
}
