import {
  ContentPost,
  ContentStatus,
  ContentTargetType,
  ContentType,
} from './domain/entities/content-post.entity';

/**
 * Filter shape for `ContentRepository.list`. Each field is optional;
 * absent fields are not constrained. Date-range filters use inclusive
 * `[from, to]` bounds.
 *
 *   - `cursorId` + `limit` drive the keyset pagination. The relational
 *     impl orders by `(created_at DESC, id DESC)` for consistency across
 *     statuses; callers wanting "by published date" should pass
 *     `status='published'` and rely on the index `idx_content_posts_kg_published_at`.
 */
export interface ListContentFilters {
  contentType?: ContentType;
  status?: ContentStatus;
  targetType?: ContentTargetType;
  targetGroupId?: string;
  targetChildId?: string;
  scheduledFrom?: Date;
  scheduledTo?: Date;
  publishedFrom?: Date;
  publishedTo?: Date;
  cursorId?: string;
  cursorCreatedAt?: Date;
  limit?: number;
}

/**
 * Patch payload for `transitionStatus`. Only fields present are written
 * via SQL — callers must ALWAYS pass `updatedAt` so the trigger does not
 * race with the conditional update.
 */
export interface TransitionStatusPatch {
  publishedAt?: Date | null;
  scheduledFor?: Date | null;
  updatedAt: Date;
}

/**
 * Persistence port for `ContentPost` (B17 §9). The relational impl is
 * tenant-scoped via `tenantStorage` — RLS filters rows by the ambient
 * `kindergarten_id` GUC, and the service.ts caller still passes
 * `kgId` explicitly for IDE-navigation + defence-in-depth.
 */
export abstract class ContentRepository {
  abstract create(post: ContentPost): Promise<ContentPost>;

  /**
   * Full-row UPDATE by id. Callers using this method are expected to have
   * already applied state-machine guards on the domain entity. For
   * status-flip operations (`draft → scheduled`, `* → published`) use
   * `transitionStatus` instead — its conditional WHERE-status closes
   * concurrent-writer races.
   */
  abstract update(post: ContentPost): Promise<ContentPost>;

  /** DELETE WHERE id AND kindergarten_id. Returns true if a row was deleted. */
  abstract delete(kindergartenId: string, id: string): Promise<boolean>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<ContentPost | null>;

  abstract list(
    kindergartenId: string,
    filters: ListContentFilters,
  ): Promise<ContentPost[]>;

  /**
   * Conditional UPDATE — flips status only when the current row's
   * status equals `expectedStatus`. Returns the hydrated domain row on
   * success, `null` on 0-rows (caller maps to `ContentPostStatusInvalidError`).
   *
   * Implementation: `UPDATE content_posts SET status=$new, ...patch
   * WHERE id=$id AND kindergarten_id=$kg AND status=$expected RETURNING *`.
   */
  abstract transitionStatus(
    kindergartenId: string,
    id: string,
    expectedStatus: ContentStatus,
    newStatus: ContentStatus,
    patch: TransitionStatusPatch,
  ): Promise<ContentPost | null>;

  /**
   * Lists scheduled posts whose `scheduled_for <= now`. Used by the
   * `content-publish` cron processor to flip them to `'published'`.
   * Relies on `idx_content_posts_kg_scheduled_for` (partial index where
   * `status='scheduled'`).
   */
  abstract listScheduledDue(
    kindergartenId: string,
    now: Date,
    limit: number,
  ): Promise<ContentPost[]>;

  /**
   * Idempotency check for the birthday-generation cron. Returns true iff
   * a `content_type='birthday'` post for `targetChildId` already exists
   * with `DATE(published_at AT TIME ZONE 'Asia/Almaty') = date::date`.
   *
   * Birthday posts auto-publish (status='published', published_at=now);
   * we anchor the de-dup window on the calendar date in Asia/Almaty so a
   * 23:59 run and a 00:01 run on the next day each get fresh windows.
   */
  abstract existsBirthdayForChildOnDate(
    kindergartenId: string,
    childId: string,
    date: Date,
  ): Promise<boolean>;

  /**
   * B17 T8 HIGH#5 — per-(kg, child, calendar-date) advisory lock keyed by
   * `pg_advisory_xact_lock(hashtext('birthday:'||kg||':'||childId||':'||yyyy-mm-dd))`.
   * Held until the surrounding TX boundary so concurrent
   * `BirthdayGeneratorService.runDaily` invocations (cron + manual saas
   * trigger, or two cron ticks before persistence) serialize on the
   * check-then-insert sequence and observe each other's writes.
   *
   * Outside an ambient HTTP TX (CLI / direct invocation) the lock is taken
   * on the default pool's implicit per-statement TX and released
   * immediately — effectively a no-op, which is fine because those code
   * paths don't race.
   *
   * Default-no-op so older test fakes compile; the relational impl
   * overrides with the real SQL.
   */
  acquireBirthdayAdvisoryLock(
    _kindergartenId: string,
    _childId: string,
    _date: Date,
  ): Promise<void> {
    return Promise.resolve();
  }
}
