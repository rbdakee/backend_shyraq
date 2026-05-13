import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
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
import { RolesGuard } from '@/common/guards/roles.guard';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { BirthdayGenerationProcessor } from './processors/birthday-generation.processor';
import { ContentPublishProcessor } from './processors/content-publish.processor';
import { StoryCleanupProcessor } from './processors/story-cleanup.processor';
import { RunTriggerDto } from './dto/saas/run-trigger.dto';
import { RunTriggerResponseDto } from './dto/responses/run-trigger-response.dto';

/**
 * SaaS super-admin manual triggers for B17 content processors
 * (endpoints.md §1.7).
 *
 * Each endpoint directly calls the processor's `runOnce(now)` method
 * synchronously (unlike the billing SaaS controller which enqueues to BullMQ).
 * B17 processors are small — birthday-generation iterates kg children,
 * story-cleanup sweeps expired rows, publish-scheduled flips drafts. Async
 * BullMQ enqueue is deferred to B22 if operators need non-blocking triggers
 * for very large datasets.
 *
 * `@SuperAdminScope()` switches the wrapping HTTP TX into `bypass_rls=true`
 * so the processors' cross-tenant DB calls are consistent with the ambient
 * scope.
 */
@ApiTags('SaaS / Content')
@ApiBearerAuth()
@Controller({ path: 'saas/content', version: '1' })
@UseGuards(RolesGuard)
@SuperAdminScope()
@Roles('super_admin', 'support')
export class SaasContentController {
  constructor(
    private readonly birthdayProcessor: BirthdayGenerationProcessor,
    private readonly publishProcessor: ContentPublishProcessor,
    private readonly cleanupProcessor: StoryCleanupProcessor,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  @Post('birthday-run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually trigger the birthday-generation processor (cross-tenant). Idempotent — skips children that already have a birthday post for today. Optional `now` overrides the run date (YYYY-MM-DD or ISO-8601).',
  })
  @ApiOkResponse({
    type: RunTriggerResponseDto,
    description:
      'Summary: posts_created, posts_skipped, kindergartens_processed.',
  })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  async birthdayRun(
    @Body() dto: RunTriggerDto,
  ): Promise<RunTriggerResponseDto> {
    const now = dto.now ? new Date(dto.now) : this.clock.now();
    const result = await this.birthdayProcessor.runOnce(now);
    const response = new RunTriggerResponseDto();
    response.triggered_at = result.now;
    response.processed_count = result.generatedCount;
    response.skipped_count = result.skippedCount;
    response.kindergartens_processed = result.kindergartensProcessed;
    return response;
  }

  @Post('story-cleanup-run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually trigger the story-cleanup processor (cross-tenant). Deletes group_stories with expires_at <= now and best-effort-removes their media files. Optional `now` to anchor expiry evaluation.',
  })
  @ApiOkResponse({
    type: RunTriggerResponseDto,
    description: 'Summary: deleted_count, kindergartens_processed.',
  })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  async storyCleanupRun(
    @Body() dto: RunTriggerDto,
  ): Promise<RunTriggerResponseDto> {
    const now = dto.now ? new Date(dto.now) : this.clock.now();
    const result = await this.cleanupProcessor.runOnce(now);
    const response = new RunTriggerResponseDto();
    response.triggered_at = result.now;
    response.processed_count = result.deletedCount;
    response.skipped_count = 0;
    response.kindergartens_processed = result.kindergartensProcessed;
    return response;
  }

  @Post('publish-scheduled-run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Manually trigger the content-publish processor (cross-tenant). Flips scheduled content_posts with scheduled_for <= now to published and emits notification events. Optional `now` to anchor the evaluation.',
  })
  @ApiOkResponse({
    type: RunTriggerResponseDto,
    description: 'Summary: published_count, kindergartens_processed.',
  })
  @ApiBadRequestResponse({ description: 'Validation error.' })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({ description: 'Caller is not super_admin/support.' })
  async publishScheduledRun(
    @Body() dto: RunTriggerDto,
  ): Promise<RunTriggerResponseDto> {
    const now = dto.now ? new Date(dto.now) : this.clock.now();
    const result = await this.publishProcessor.runOnce(now);
    const response = new RunTriggerResponseDto();
    response.triggered_at = result.now;
    response.processed_count = result.publishedCount;
    response.skipped_count = result.skippedCount;
    response.kindergartens_processed = result.kindergartensProcessed;
    return response;
  }
}
