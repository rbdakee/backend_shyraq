import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
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
import {
  ApproveGuardianDto,
  EffectivePermissionsDto,
  GuardianDto,
  ToggleApprovalRightsDto,
  UpdateGuardianPermissionsDto,
} from './dto';

/**
 * Parent-side guardian state-machine endpoints. The caller is expected to be
 * an APPROVED PRIMARY guardian on the same child as the target guardian; both
 * `ChildAccessGuard` (cross-tenant lookup of the calling user's guardian
 * rows) and `ChildService.assertCallerIsApprovedPrimary` enforce this.
 */
@ApiTags('Guardian Approvals (Parent)')
@ApiBearerAuth()
@Controller({ path: 'parent/approvals', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, ChildAccessGuard)
export class ParentApprovalController {
  constructor(private readonly service: ChildService) {}

  @Get('pending')
  @ApiOperation({
    summary:
      'List pending_approval guardian rows on children where I am an approved primary.',
  })
  @ApiOkResponse({ type: [GuardianDto] })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'tenant_required.' })
  async listPending(
    @Tenant() t: TenantContext,
    @CurrentUser() user: JwtPayload,
  ): Promise<GuardianDto[]> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const rows = await this.service.listPendingApprovalsForPrimary(
      t.kgId,
      user.sub,
    );
    const identities = await this.service.resolveGuardianIdentities(rows);
    return rows.map((g) =>
      ChildPresenter.guardian(g, identities.get(g.userId)),
    );
  }

  @Post(':guardianId/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Approve a pending_approval guardian. Optionally also grant approval rights (≤2 cap).',
  })
  @ApiBody({ type: ApproveGuardianDto })
  @ApiOkResponse({ type: GuardianDto })
  @ApiForbiddenResponse({ description: 'not_primary_guardian.' })
  @ApiNotFoundResponse({ description: 'child_guardian not found.' })
  @ApiConflictResponse({ description: 'max_approval_rights_exceeded.' })
  @ApiUnprocessableEntityResponse({
    description: 'invalid_guardian_status_transition.',
  })
  async approve(
    @Tenant() t: TenantContext,
    @Param('guardianId', new ParseUUIDPipe()) guardianId: string,
    @Body() dto: ApproveGuardianDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<GuardianDto> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const guardian = await this.service.approveGuardian(
      t.kgId,
      user.sub,
      guardianId,
      dto.grant_approval_rights ?? false,
    );
    return ChildPresenter.guardian(
      guardian,
      await this.service.resolveGuardianIdentity(guardian),
    );
  }

  @Post(':guardianId/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a pending_approval guardian.' })
  @ApiOkResponse({ type: GuardianDto })
  @ApiForbiddenResponse({ description: 'not_primary_guardian.' })
  async reject(
    @Tenant() t: TenantContext,
    @Param('guardianId', new ParseUUIDPipe()) guardianId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<GuardianDto> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const guardian = await this.service.rejectGuardian(
      t.kgId,
      user.sub,
      guardianId,
    );
    return ChildPresenter.guardian(
      guardian,
      await this.service.resolveGuardianIdentity(guardian),
    );
  }

  @Post(':guardianId/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke an approved guardian (primary-side).' })
  @ApiOkResponse({ type: GuardianDto })
  @ApiForbiddenResponse({ description: 'not_primary_guardian.' })
  async revoke(
    @Tenant() t: TenantContext,
    @Param('guardianId', new ParseUUIDPipe()) guardianId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<GuardianDto> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const guardian = await this.service.revokeGuardianByPrimary(
      t.kgId,
      user.sub,
      guardianId,
    );
    return ChildPresenter.guardian(
      guardian,
      await this.service.resolveGuardianIdentity(guardian),
    );
  }

  @Patch(':guardianId/rights')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Toggle has_approval_rights (cap of 2 per child).',
  })
  @ApiBody({ type: ToggleApprovalRightsDto })
  @ApiOkResponse({ type: GuardianDto })
  @ApiConflictResponse({ description: 'max_approval_rights_exceeded.' })
  async toggleRights(
    @Tenant() t: TenantContext,
    @Param('guardianId', new ParseUUIDPipe()) guardianId: string,
    @Body() dto: ToggleApprovalRightsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<GuardianDto> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const guardian = await this.service.toggleGuardianApprovalRights(
      t.kgId,
      user.sub,
      guardianId,
      dto.grant,
    );
    return ChildPresenter.guardian(
      guardian,
      await this.service.resolveGuardianIdentity(guardian),
    );
  }

  @Patch(':guardianId/permissions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Patch the guardian's per-permission overrides (toggleable keys only).",
    description:
      'Locked keys (prepayment, trusted_people_manage) are rejected with 400. Status must be approved.',
  })
  @ApiBody({ type: UpdateGuardianPermissionsDto })
  @ApiOkResponse({ type: EffectivePermissionsDto })
  async updatePermissions(
    @Tenant() t: TenantContext,
    @Param('guardianId', new ParseUUIDPipe()) guardianId: string,
    @Body() dto: UpdateGuardianPermissionsDto,
    @CurrentUser() user: JwtPayload,
  ): Promise<EffectivePermissionsDto> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const out = await this.service.updateGuardianPermissions(
      t.kgId,
      user.sub,
      guardianId,
      dto.permissions,
    );
    return ChildPresenter.effectivePermissions(out.guardian);
  }

  @Post(':guardianId/permissions/reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reset guardian permissions to role defaults.',
  })
  @ApiOkResponse({ type: EffectivePermissionsDto })
  async resetPermissions(
    @Tenant() t: TenantContext,
    @Param('guardianId', new ParseUUIDPipe()) guardianId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<EffectivePermissionsDto> {
    if (!t.kgId) throw new BadRequestException('tenant_required');
    const out = await this.service.resetGuardianPermissions(
      t.kgId,
      user.sub,
      guardianId,
    );
    return ChildPresenter.effectivePermissions(out.guardian);
  }
}
