import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Queue } from 'bullmq';
import { Roles } from '@/common/decorators/roles.decorator';
import { SuperAdminScope } from '@/common/decorators/super-admin-scope.decorator';
import { RolesGuard } from '@/common/guards/roles.guard';
import {
  TriggerMonthlyRunDto,
  TriggerMonthlyRunResponseDto,
} from './dto/saas-billing.dto';
import {
  MONTHLY_BILLING_MANUAL_JOB,
  MONTHLY_BILLING_QUEUE,
  MonthlyBillingJobData,
} from './monthly-billing.processor';

/**
 * SaasBillingController — super-admin / support trigger that pushes a
 * one-shot job onto the `billing-monthly` queue for back-fill or demo
 * runs. The processor (`MonthlyBillingProcessor`) iterates every active
 * kindergarten under `app.bypass_rls=true`, so the trigger is naturally
 * cross-tenant. `@SuperAdminScope()` switches the wrapping HTTP TX into
 * bypass-RLS mode for the controller's own bookkeeping.
 *
 * B13 contract:
 *   - `kindergarten_id` (single-kg trigger) is NOT supported in B13. The
 *     processor's `process()` does not yet accept a kg filter; adding it
 *     is deferred to B22 polish where a supplemental endpoint can route
 *     to a single-kg invocation of `runForKindergarten`. Calls that
 *     include the field are rejected with 400 so the contract stays
 *     explicit. Operators wanting per-kg testing can call
 *     `MonthlyBillingProcessor.runForKindergarten` directly via an
 *     integration script.
 *   - `period_start` (optional) overrides the cron's "first-of-month in
 *     Asia/Almaty" default — useful for back-filling missed months.
 */
@ApiTags('SaaS / Billing')
@ApiBearerAuth()
@Controller({ path: 'saas/billing', version: '1' })
@UseGuards(RolesGuard)
@SuperAdminScope()
@Roles('super_admin', 'support')
export class SaasBillingController {
  constructor(
    @InjectQueue(MONTHLY_BILLING_QUEUE)
    private readonly monthlyQueue: Queue<MonthlyBillingJobData>,
  ) {}

  @Post('monthly-run')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Manually enqueue the monthly billing run (cross-tenant). Async — returns the BullMQ job id immediately. Used for back-fill, demo, and recovery from a missed cron tick.',
  })
  @ApiBody({ type: TriggerMonthlyRunDto })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    type: TriggerMonthlyRunResponseDto,
    description:
      'Job enqueued. Inspect BullMQ for completion / per-kg counts via the worker logs.',
  })
  @ApiBadRequestResponse({
    description:
      'Validation error, or `kindergarten_id` was supplied (single-kg trigger is deferred to B22).',
  })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  async triggerMonthlyRun(
    @Body() body: TriggerMonthlyRunDto,
  ): Promise<TriggerMonthlyRunResponseDto> {
    if (body.kindergarten_id) {
      // Per-kg trigger requires the processor to accept a kg filter.
      // Implementing that surface is deferred to B22 — see class doc.
      throw new BadRequestException('single_kg_trigger_not_supported_b13');
    }
    const jobData: MonthlyBillingJobData = {};
    if (body.period_start) {
      jobData.periodStart = body.period_start;
    }
    const job = await this.monthlyQueue.add(
      MONTHLY_BILLING_MANUAL_JOB,
      jobData,
      {
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    );
    return {
      job_id: job.id ?? `${MONTHLY_BILLING_MANUAL_JOB}:${Date.now()}`,
      status: 'enqueued',
    };
  }
}
