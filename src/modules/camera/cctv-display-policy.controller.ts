import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { CctvDisplayPolicyPresenter } from './cctv-display-policy.presenter';
import { CctvDisplayPolicyService } from './cctv-display-policy.service';
import { CameraNotFoundError } from './domain/errors/camera-not-found.error';
import { CctvDisplayPolicyDto } from './dto/cctv-display-policy-response.dto';
import { UpdateCctvDisplayPolicyDto } from './dto/update-cctv-display-policy.dto';

/**
 * Admin control over what parents are shown in the app, and when.
 *
 * Its own route rather than a `/cameras` sub-path: the policy is a single
 * per-kindergarten setting, not a camera, and `/cameras/:id` would swallow the
 * path anyway.
 */
@ApiTags('CCTV display policy (Admin)')
@ApiBearerAuth()
@Controller({ path: 'cctv/display-policy', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('admin')
export class CctvDisplayPolicyController {
  constructor(private readonly service: CctvDisplayPolicyService) {}

  @Get()
  @ApiOperation({
    summary: 'What parents currently see, and when.',
    description:
      'Always answers: a kindergarten that has never saved a policy gets the defaults — no common cameras and a disabled night rule. The group camera is always shown to the parent and is not part of the policy.',
  })
  @ApiOkResponse({ type: CctvDisplayPolicyDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  async get(@Tenant() tenant: TenantContext): Promise<CctvDisplayPolicyDto> {
    if (!tenant.kgId) throw new CameraNotFoundError('<no-tenant>');
    const policy = await this.service.get(tenant.kgId);
    return CctvDisplayPolicyPresenter.policy(policy);
  }

  @Put()
  @ApiOperation({
    summary: 'Replace the display policy.',
    description:
      'Whole-object write — send every field. Takes effect on the next parent request; nothing is pushed, and already-issued stream tokens keep working until they expire.',
  })
  @ApiOkResponse({ type: CctvDisplayPolicyDto })
  @ApiBadRequestResponse({
    description:
      '`cctv_policy_window_invalid` — a rule with `from` equal to `to`. `cctv_policy_time_invalid` — malformed wall clock. `cctv_policy_work_day_invalid` — weekday outside 1..7. `cctv_policy_rule_camera_not_common` — a rule hides a camera that is not in `common_camera_ids`.',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not an admin.' })
  @ApiNotFoundResponse({
    description:
      '`not_found` (the wire code every NotFoundError carries) — an id names no camera of this tenant.',
  })
  @ApiUnprocessableEntityResponse({
    description: '`camera_archived` — an id names an archived camera.',
  })
  async put(
    @Tenant() tenant: TenantContext,
    @Body() dto: UpdateCctvDisplayPolicyDto,
  ): Promise<CctvDisplayPolicyDto> {
    if (!tenant.kgId) throw new CameraNotFoundError('<no-tenant>');
    const policy = await this.service.save(tenant.kgId, {
      commonCameraIds: dto.common_camera_ids,
      hideRules: dto.hide_rules.map((rule) => ({
        name: rule.name,
        enabled: rule.enabled,
        days: rule.days,
        from: rule.from,
        to: rule.to,
        allCameras: rule.all_cameras,
        cameraIds: rule.camera_ids,
      })),
    });
    return CctvDisplayPolicyPresenter.policy(policy);
  }
}
