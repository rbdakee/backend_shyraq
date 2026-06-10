import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
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
import { PendingApplicantRequestDto } from './dto/pending-applicant-request.dto';

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
    // Two paths:
    //   - kg-scoped JWT (single approved kg)  → list inside that tenant.
    //   - unscoped JWT  (zero or multiple approved kgs) → cross-tenant fan-out
    //     using the bypass-RLS service path. This is the same lookup
    //     `assembleRoles` uses to decide which kgs a parent has roles in, so
    //     scope leakage is bounded by the user's own approved-guardian rows.
    const rows = t.kgId
      ? await this.service.listMyChildren(t.kgId, user.sub)
      : await this.service.listMyChildrenCrossTenant(user.sub);
    return rows.map((c) => ChildPresenter.child(c));
  }

  // NOTE: declared BEFORE `@Get(':id')` so the static `pending-requests`
  // segment wins over the `:id` param route (Express matches in registration
  // order). ChildAccessGuard is a no-op here — there is no `:id`/`:childId`/
  // `:guardianId` param, so it returns early without a guardian lookup.
  @Get('pending-requests')
  @ApiOperation({
    summary: 'Мои заявки на привязку, ожидающие подтверждения (заявитель).',
    description:
      "Applicant's view of their OWN `link` requests still in " +
      '`pending_approval` — the requests awaiting approval by an admin or the ' +
      'primary guardian. Complements GET /parent/approvals/pending (the ' +
      'primary guardian view of "who do I approve"). Cross-tenant: a parent ' +
      'may have pending requests in several kindergartens. Child PII stays ' +
      'hidden until approval (same rule as /link) — only a masked child name ' +
      'is returned, never IIN / date-of-birth / photo / group.',
  })
  @ApiOkResponse({
    description:
      "The caller's pending link requests (possibly empty). Child name is " +
      'masked to first-letter + ****.',
    type: [PendingApplicantRequestDto],
  })
  @ApiUnauthorizedResponse({ description: 'invalid_token / token_revoked.' })
  @ApiForbiddenResponse({ description: 'pending_role_select.' })
  async pendingRequests(
    @CurrentUser() user: JwtPayload,
  ): Promise<PendingApplicantRequestDto[]> {
    const views = await this.service.listPendingApplicantRequests(user.sub);
    return views.map((v) => ChildPresenter.pendingApplicantRequest(v));
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
    const identities = await this.service.resolveGuardianIdentities(
      out.guardians,
    );
    return {
      child: ChildPresenter.child(out.child),
      guardians: out.guardians.map((g) =>
        ChildPresenter.guardian(g, identities.get(g.userId)),
      ),
    };
  }

  @Post(':id/unlink')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Отвязать себя от ребёнка (soft-revoke).',
    description:
      'Revokes the calling guardian own approved row (secondary or nanny). ' +
      'Primary guardians cannot self-unlink (primary lifecycle is managed by admins). ' +
      'ChildAccessGuard (class-level) ensures the caller is an approved guardian of this child.',
  })
  @ApiNoContentResponse({ description: 'Guardian row revoked.' })
  @ApiUnauthorizedResponse({ description: 'invalid_token / token_revoked.' })
  @ApiForbiddenResponse({
    description: 'primary_cannot_self_unlink | not an approved guardian.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async unlink(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) childId: string,
  ): Promise<void> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    await this.service.selfUnlinkFromChild(t.kgId, user.sub, childId);
  }
}
