import { GroupStory } from './domain/entities/group-story.entity';

/**
 * Persistence port for `GroupStory` (B17 §9.6). Tenant-scoped via
 * `tenantStorage` — relational impl resolves the working `EntityManager`
 * from there so RLS filters by the ambient `app.kindergarten_id` GUC.
 */
export abstract class GroupStoryRepository {
  abstract create(story: GroupStory): Promise<GroupStory>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<GroupStory | null>;

  /** DELETE WHERE id AND kindergarten_id. Returns true if a row was deleted. */
  abstract delete(kindergartenId: string, id: string): Promise<boolean>;

  /**
   * Returns the active (non-expired, `expires_at > now`) stories for a
   * single group, ordered by `created_at DESC` so the newest story is
   * first. Used by the parent feed.
   */
  abstract listActiveByGroup(
    kindergartenId: string,
    groupId: string,
    now: Date,
  ): Promise<GroupStory[]>;

  /**
   * Multi-group variant of `listActiveByGroup`. Empty input returns `[]`
   * without a query.
   */
  abstract listActiveByGroupIds(
    kindergartenId: string,
    groupIds: string[],
    now: Date,
  ): Promise<GroupStory[]>;

  /**
   * Atomic `UPDATE group_stories SET views = views + 1 WHERE id AND kg`.
   * Returns `true` iff a row was updated (`false` for not-found).
   */
  abstract incrementViews(kindergartenId: string, id: string): Promise<boolean>;

  /**
   * Returns expired stories (`expires_at <= now`) up to `limit`. Used by
   * the hourly `story-cleanup` cron — the processor walks each row and
   * calls `FileStoragePort.delete(extractKey(media_url))` before
   * `deleteById`.
   */
  abstract listExpired(
    kindergartenId: string,
    now: Date,
    limit: number,
  ): Promise<GroupStory[]>;

  /** Alias of `delete` — kept for processor-side readability. */
  abstract deleteById(kindergartenId: string, id: string): Promise<boolean>;
}
