import {
  GroupStory,
  GroupStoryState,
} from '../../../../domain/entities/group-story.entity';
import { GroupStoryRelationalEntity } from '../entities/group-story.typeorm.entity';

export class GroupStoryMapper {
  static toDomain(row: GroupStoryRelationalEntity): GroupStory {
    const state: GroupStoryState = {
      id: row.id,
      kindergartenId: row.kindergarten_id,
      groupId: row.group_id,
      createdBy: row.created_by,
      mediaUrl: row.media_url,
      mediaType: row.media_type,
      caption: row.caption,
      views: row.views,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    };
    return GroupStory.fromState(state);
  }

  static toRelational(story: GroupStory): GroupStoryRelationalEntity {
    const s = story.toState();
    const e = new GroupStoryRelationalEntity();
    e.id = s.id;
    e.kindergarten_id = s.kindergartenId;
    e.group_id = s.groupId;
    e.created_by = s.createdBy;
    e.media_url = s.mediaUrl;
    e.media_type = s.mediaType;
    e.caption = s.caption;
    e.views = s.views;
    e.expires_at = s.expiresAt;
    e.created_at = s.createdAt;
    return e;
  }
}
