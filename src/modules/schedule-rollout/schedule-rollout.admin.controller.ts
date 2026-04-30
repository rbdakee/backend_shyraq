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
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { SuperAdminScope } from '@/common/decorators/super-admin-scope.decorator';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';
import { PendingRoleSelectGuard } from '@/common/guards/pending-role-select.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import { RunWeeklyRolloutDto } from './dto/run-weekly-rollout.dto';
import { RolloutSummaryResponseDto } from './dto/rollout-summary.response.dto';
import { WeeklyRolloutService } from './weekly-rollout.service';

/**
 * Admin / Schedule rollout controller — manual trigger for the cron
 * `schedule:weekly-rollout`. Combines schedule + meal copy in a single call
 * so an operator can re-fire the whole rollout end-to-end after a cron
 * miss.
 *
 * Scope: SuperAdmin only — the rollout iterates EVERY active kindergarten
 * (the cron's contract). A per-kg admin already has
 * `POST /admin/schedule/week-snapshots/copy` and
 * `POST /admin/meal-plans/copy-week` for their own scope.
 *
 * Idempotency: relayed from the underlying services. A second call with
 * the same `fromMonday` will return the same totals with everything
 * counted under `skippedGroups` / `plansSkipped`.
 */
@ApiTags('Admin / Schedule Rollout')
@ApiBearerAuth()
@Controller({ path: 'admin/schedule/week-rollout', version: '1' })
@UseGuards(JwtAuthGuard, PendingRoleSelectGuard, RolesGuard)
@Roles('super_admin')
@SuperAdminScope()
export class ScheduleRolloutAdminController {
  constructor(private readonly rollout: WeeklyRolloutService) {}

  @Post('run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually run the weekly auto-copy rollout (schedule + meal) across every active kindergarten. Idempotent: re-runs are safe.',
  })
  @ApiOkResponse({ type: RolloutSummaryResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not a super_admin.' })
  async run(
    @Body() dto: RunWeeklyRolloutDto,
  ): Promise<RolloutSummaryResponseDto> {
    const fromMonday = dto.fromMonday
      ? new Date(`${dto.fromMonday}T00:00:00.000Z`)
      : this.rollout.computePreviousMonday(new Date());
    const summary = await this.rollout.runWeeklyRollout({
      fromMonday,
      source: 'manual',
    });
    return {
      fromMonday: summary.fromMonday,
      source: summary.source,
      kindergartens: summary.kindergartens,
      totals: summary.totals,
    };
  }
}
