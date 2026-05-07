import {
  ContentPost,
  ContentPostState,
} from '../../../../domain/entities/content-post.entity';
import { ContentPostRelationalEntity } from '../entities/content-post.relational-entity';

export class ContentPostMapper {
  static toDomain(row: ContentPostRelationalEntity): ContentPost {
    const state: ContentPostState = {
      id: row.id,
      kindergartenId: row.kindergarten_id,
      contentType: row.content_type,
      targetType: row.target_type,
      targetGroupId: row.target_group_id,
      targetChildId: row.target_child_id,
      title: row.title,
      body: row.body,
      titleI18n: row.title_i18n,
      bodyI18n: row.body_i18n,
      mediaUrls: row.media_urls,
      metadata: row.metadata,
      scheduledFor: row.scheduled_for,
      publishedAt: row.published_at,
      expiresAt: row.expires_at,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    return ContentPost.fromState(state);
  }

  static toRelational(post: ContentPost): ContentPostRelationalEntity {
    const s = post.toState();
    const e = new ContentPostRelationalEntity();
    e.id = s.id;
    e.kindergarten_id = s.kindergartenId;
    e.content_type = s.contentType;
    e.target_type = s.targetType;
    e.target_group_id = s.targetGroupId;
    e.target_child_id = s.targetChildId;
    e.title = s.title;
    e.body = s.body;
    e.title_i18n = s.titleI18n;
    e.body_i18n = s.bodyI18n;
    e.media_urls = s.mediaUrls;
    e.metadata = s.metadata;
    e.scheduled_for = s.scheduledFor;
    e.published_at = s.publishedAt;
    e.expires_at = s.expiresAt;
    e.status = s.status;
    e.created_by = s.createdBy;
    e.created_at = s.createdAt;
    e.updated_at = s.updatedAt;
    return e;
  }
}
