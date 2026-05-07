import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a group_stories row that is not visible under
 * the caller's tenant scope (or simply does not exist).
 *
 * Note: an *expired* story is a different condition — see
 * `GroupStoryExpiredError` (410 Gone). Callers reading expired rows that
 * have not yet been swept by the `story-cleanup` cron should receive 410,
 * not 404.
 */
export class GroupStoryNotFoundError extends NotFoundError {
  public readonly code = 'group_story_not_found' as const;

  constructor(storyId: string) {
    super('group_story', storyId);
  }
}
