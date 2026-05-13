import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { AdminLifecycleService } from './admin-lifecycle.service';
import {
  LifecycleFailedJobDto,
  ListFailedLifecycleJobsQueryDto,
  ListLifecycleFailedJobsResponseDto,
  RetryLifecycleFailedJobResponseDto,
} from './dto';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * AdminLifecycleController — operator surface over the BullMQ `lifecycle`
 * queue's failed-jobs DLQ (B22a T10 closes B21 T7-L2).
 *
 * Auth chain: `JwtAuthGuard` + `PendingRoleSelectGuard` + `RolesGuard` +
 * `KindergartenScopeGuard` (the global guard from `app.module.ts`).
 * Endpoints are scoped per-kg: a kindergarten admin sees only failed jobs
 * whose `payload.kindergartenId` matches their own. Super-admin support
 * is intentionally NOT wired here yet — when needed, a parallel
 * `saas-lifecycle.controller.ts` can call `service.listFailedJobs({})`
 * (omit `kgId`) under `@SuperAdminScope()`.
 *
 * Wire contract is owned by `docs/endpoints.md` §2.24. snake_case for
 * response/query fields per project convention.
 */
@ApiTags('Admin / Lifecycle DLQ')
@ApiBearerAuth()
@Controller({ path: 'admin/lifecycle/failed-jobs', version: '1' })
@UseGuards(RolesGuard)
@Roles('admin')
export class AdminLifecycleController {
  constructor(private readonly service: AdminLifecycleService) {}

  @Get()
  @ApiOperation({
    summary:
      'List failed BullMQ `lifecycle` queue jobs filtered to the caller’s kindergarten. Offset-based cursor pagination via `limit` + `cursor`.',
  })
  @ApiOkResponse({ type: ListLifecycleFailedJobsResponseDto })
  @ApiBadRequestResponse({
    description: 'Validation error (e.g. limit out of 1..200).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not admin.' })
  @ApiTooManyRequestsResponse({
    description: 'Rate-limit on the auth gateway.',
  })
  async list(
    @Tenant() t: TenantContext,
    @Query() query: ListFailedLifecycleJobsQueryDto,
  ): Promise<ListLifecycleFailedJobsResponseDto> {
    const kgId = requireTenant(t);
    const result = await this.service.listFailedJobs(
      { kgId },
      query.limit,
      query.cursor,
    );
    // Service-shape (camelCase) → wire-shape (snake_case).
    const items: LifecycleFailedJobDto[] = result.items.map((it) => ({
      id: it.id,
      name: it.name,
      payload: it.payload,
      failed_reason: it.failedReason,
      attempts_made: it.attemptsMade,
      timestamp: it.timestamp,
      finished_on: it.finishedOn,
    }));
    return { items, next_cursor: result.nextCursor };
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Re-enqueue a failed `lifecycle` queue job. Only failed jobs can be retried; non-failed states return 409. Per-kg admins can only retry jobs whose `payload.kindergartenId` matches.',
  })
  @ApiBody({ schema: { type: 'object', additionalProperties: false } })
  @ApiAcceptedResponse({
    type: RetryLifecycleFailedJobResponseDto,
    description: 'Job re-enqueued (HTTP 202).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description:
      'Caller is not admin, or job belongs to a different kindergarten (`forbidden`).',
  })
  @ApiNotFoundResponse({
    description: 'Job not found in BullMQ (`lifecycle_job_not_found`).',
  })
  @ApiConflictResponse({
    description:
      'Job is not in failed state (`lifecycle_job_not_in_failed_state`) — already retried, currently active, or completed.',
  })
  @ApiTooManyRequestsResponse({
    description: 'Rate-limit on the auth gateway.',
  })
  async retry(
    @Tenant() t: TenantContext,
    @Param('id') id: string,
    @Body() _body: Record<string, never>,
  ): Promise<RetryLifecycleFailedJobResponseDto> {
    const kgId = requireTenant(t);
    return this.service.retryFailedJob({ kgId }, id);
  }
}
