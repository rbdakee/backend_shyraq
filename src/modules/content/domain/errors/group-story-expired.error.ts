import { GoneError } from '@/shared-kernel/domain/errors';

/**
 * 410 — the caller asked to read or interact with a group_story whose
 * `expires_at` is in the past. The 24-hour TTL is enforced both at read time
 * (this error) and asynchronously by the `story-cleanup` cron job that
 * deletes expired rows hourly. There is a small window between expiry and
 * physical deletion during which the row still exists; this error prevents
 * stale content from leaking out.
 *
 * 410 (vs. 404) signals that the story is *known* to be gone — clients
 * should not retry the same id.
 */
export class GroupStoryExpiredError extends GoneError {
  public readonly code = 'group_story_expired' as const;
  public readonly details: { storyId: string; expiresAt: string };

  constructor(storyId: string, expiresAt: Date) {
    super('group_story_expired', `group story ${storyId} expired`);
    this.details = { storyId, expiresAt: expiresAt.toISOString() };
  }
}
