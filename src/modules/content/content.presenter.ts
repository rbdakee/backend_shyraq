import { ContentPost } from './domain/entities/content-post.entity';
import { GroupStory } from './domain/entities/group-story.entity';
import { ContentFeedResult } from './content-feed.service';
import { ContentFeedResponseDto } from './dto/responses/content-feed-response.dto';
import { ContentListResponseDto } from './dto/responses/content-list-response.dto';
import { ContentPostResponseDto } from './dto/responses/content-post-response.dto';
import { GroupStoryResponseDto } from './dto/responses/group-story-response.dto';
import { StoryListResponseDto } from './dto/responses/story-list-response.dto';

export class ContentPresenter {
  static contentPost(post: ContentPost): ContentPostResponseDto {
    const s = post.toState();
    const dto = new ContentPostResponseDto();
    dto.id = s.id;
    dto.kindergarten_id = s.kindergartenId;
    dto.content_type = s.contentType;
    dto.target_type = s.targetType;
    dto.target_group_id = s.targetGroupId;
    dto.target_child_id = s.targetChildId;
    dto.title = s.title;
    dto.body = s.body;
    dto.title_i18n = s.titleI18n;
    dto.body_i18n = s.bodyI18n;
    dto.media_urls = s.mediaUrls;
    dto.metadata = s.metadata;
    dto.scheduled_for = s.scheduledFor ? s.scheduledFor.toISOString() : null;
    dto.published_at = s.publishedAt ? s.publishedAt.toISOString() : null;
    dto.expires_at = s.expiresAt ? s.expiresAt.toISOString() : null;
    dto.status = s.status;
    dto.created_by = s.createdBy;
    dto.created_at = s.createdAt.toISOString();
    dto.updated_at = s.updatedAt.toISOString();
    return dto;
  }

  static groupStory(story: GroupStory): GroupStoryResponseDto {
    const s = story.toState();
    const dto = new GroupStoryResponseDto();
    dto.id = s.id;
    dto.kindergarten_id = s.kindergartenId;
    dto.group_id = s.groupId;
    dto.created_by = s.createdBy;
    dto.media_url = s.mediaUrl;
    dto.media_type = s.mediaType;
    dto.caption = s.caption;
    dto.views = s.views;
    dto.expires_at = s.expiresAt.toISOString();
    dto.created_at = s.createdAt.toISOString();
    return dto;
  }

  static contentList(
    posts: ContentPost[],
    cursor: string | null,
  ): ContentListResponseDto {
    const dto = new ContentListResponseDto();
    dto.items = posts.map((p) => ContentPresenter.contentPost(p));
    dto.cursor = cursor;
    return dto;
  }

  static storyList(stories: GroupStory[]): StoryListResponseDto {
    const dto = new StoryListResponseDto();
    dto.items = stories.map((s) => ContentPresenter.groupStory(s));
    return dto;
  }

  static contentFeed(feed: ContentFeedResult): ContentFeedResponseDto {
    const dto = new ContentFeedResponseDto();
    dto.news = feed.news.map((p) => ContentPresenter.contentPost(p));
    dto.qundylyq = feed.qundylyq.map((p) => ContentPresenter.contentPost(p));
    dto.birthdays = feed.birthdays.map((p) => ContentPresenter.contentPost(p));
    dto.stories = feed.stories.map((s) => ContentPresenter.groupStory(s));
    dto.menu_today = feed.menuToday;
    dto.schedule_today = feed.scheduleToday;
    return dto;
  }
}
