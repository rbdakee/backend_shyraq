import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '@/common/decorators/roles.decorator';
import { ChildAccessGuard } from '@/common/guards/child-access.guard';
import { RolesGuard } from '@/common/guards/roles.guard';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { Tenant } from '@/shared-kernel/interface/decorators/tenant.decorator';
import { ContentPresenter } from './content.presenter';
import { ContentFeedService } from './content-feed.service';
import { ContentFeedResponseDto } from './dto/responses/content-feed-response.dto';
import { StoryListResponseDto } from './dto/responses/story-list-response.dto';
import { ListFeedQueryDto } from './dto/parent/list-feed-query.dto';

const TENANT_REQUIRED = 'tenant_required';

function requireTenant(t: TenantContext): string {
  if (!t.kgId) throw new BadRequestException(TENANT_REQUIRED);
  return t.kgId;
}

/**
 * Parent-side content feed (B17 §9 / endpoints.md §4.9).
 *
 * Guards:
 *   - `ChildAccessGuard` verifies the caller is an approved-active guardian
 *     for `:childId` and pins `req.tenant` to the child's kindergarten.
 *   - `RolesGuard` enforces `parent` role.
 *
 * Endpoints:
 *   - `GET /parent/children/:childId/content` — aggregated feed
 *     (news + qundylyq + birthdays + stories + menu_today + schedule_today).
 *   - `GET /parent/children/:childId/stories` — active stories for
 *     the child's current group.
 */
@ApiTags('Parent / Content')
@ApiBearerAuth()
@Controller({ path: 'parent/children', version: '1' })
@UseGuards(ChildAccessGuard, RolesGuard)
@Roles('parent')
export class ParentContentController {
  constructor(private readonly feedService: ContentFeedService) {}

  @Get(':childId/content')
  @ApiOperation({
    summary:
      'Aggregated content feed for the child. Returns news + qundylyq + birthday greetings + active stories + menu_today (null until B22) + schedule_today (null until B22). Only published posts visible.',
  })
  @ApiOkResponse({ type: ContentFeedResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'access_denied — not an approved guardian for this child.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async getContentFeed(
    @Tenant() t: TenantContext,
    @Param('childId', new ParseUUIDPipe()) childId: string,
    @Query() query: ListFeedQueryDto,
  ): Promise<ContentFeedResponseDto> {
    const kgId = requireTenant(t);
    const feed = await this.feedService.getParentChildFeed(kgId, childId, {
      limit: query.limit,
    });
    return ContentPresenter.contentFeed(feed);
  }

  @Get(':childId/stories')
  @ApiOperation({
    summary:
      "Active stories (expires_at > now) for the child's current group. Returns empty list if the child has no group assignment.",
  })
  @ApiOkResponse({ type: StoryListResponseDto })
  @ApiUnauthorizedResponse({ description: 'Bearer missing/invalid/revoked.' })
  @ApiForbiddenResponse({
    description: 'access_denied — not an approved guardian for this child.',
  })
  @ApiNotFoundResponse({ description: 'child_not_found.' })
  async getChildStories(
    @Tenant() t: TenantContext,
    @Param('childId', new ParseUUIDPipe()) childId: string,
  ): Promise<StoryListResponseDto> {
    const kgId = requireTenant(t);
    const stories = await this.feedService.listActiveStoriesForChild(
      kgId,
      childId,
    );
    return ContentPresenter.storyList(stories);
  }
}
