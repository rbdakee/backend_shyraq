import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { FileUploadError } from '../errors/file-upload.error';
import { GroupStoryExpiredError } from '../errors/group-story-expired.error';
import { MediaTypeInvalidError } from '../errors/media-type-invalid.error';

/**
 * Allowed media types for a group story — mirrors DB CHECK
 * `group_stories_media_type_check` (`media_type IN ('image', 'video')`).
 */
export type StoryMediaType = 'image' | 'video';

const KNOWN_MEDIA_TYPES: ReadonlySet<StoryMediaType> = new Set([
  'image',
  'video',
]);

/** Story TTL: 24 hours from creation, per BP §9.6. */
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

export interface GroupStoryState {
  id: string;
  kindergartenId: string;
  groupId: string;
  /** users.id of the author. NOT NULL per migration. */
  createdBy: string;
  mediaUrl: string;
  mediaType: StoryMediaType;
  caption: string | null;
  views: number;
  /** `createdAt + 24h` — set by `create()`, persisted as-is by repos. */
  expiresAt: Date;
  createdAt: Date;
}

/**
 * Input to `GroupStory.create`. The author (`createdBy`) is required because
 * the DB column is NOT NULL and the BP requires every story to have an
 * accountable mentor for moderation/audit.
 */
export interface GroupStoryCreateInput {
  id: string;
  kindergartenId: string;
  groupId: string;
  createdBy: string;
  mediaUrl: string;
  mediaType: StoryMediaType;
  caption?: string | null;
  now: Date;
}

/**
 * Actor-shape for `canBeDeletedBy`. We keep the type narrow (not the full
 * user/role aggregate) so the entity stays free of cross-module imports.
 *
 * Convention: `role` is the *active* role string used elsewhere in the repo
 * (e.g. `'admin'`, `'mentor'`, `'parent'`, `'specialist'`). Service is
 * responsible for filling it from the JWT / scope guard.
 */
export interface StoryActor {
  userId: string;
  role: string;
}

/**
 * GroupStory POJO (B17 §9.6) — 24h ephemeral media post per group.
 *
 * No state machine; the only "transition" is implicit via `expiresAt` and
 * the `story-cleanup` cron. Entity-level invariants:
 *   - `mediaType` ∈ {'image', 'video'}
 *   - `mediaUrl` non-empty (after trim)
 *   - `expiresAt` is exactly `createdAt + 24h` (set by `create()`; preserved
 *     verbatim in `fromState()` for hydrated rows so the repo round-trip is
 *     lossless)
 *   - `views >= 0` (corrupted rows fail fast)
 */
export class GroupStory {
  private constructor(private state: GroupStoryState) {
    if (!KNOWN_MEDIA_TYPES.has(state.mediaType)) {
      throw new MediaTypeInvalidError(state.mediaType);
    }
    if (state.mediaUrl.trim().length === 0) {
      throw new FileUploadError('media_url_required');
    }
    if (!Number.isInteger(state.views) || state.views < 0) {
      // Defensive — DB has `views int NOT NULL DEFAULT 0` so this branch is
      // only reachable from a manually corrupted row or a bad fromState
      // payload in a test. Generic 400 via InvariantViolationError.
      throw new InvariantViolationError('group_story_views_invalid');
    }
  }

  // ── factories ──────────────────────────────────────────────────────────

  static create(input: GroupStoryCreateInput): GroupStory {
    const expiresAt = new Date(input.now.getTime() + STORY_TTL_MS);
    return new GroupStory({
      id: input.id,
      kindergartenId: input.kindergartenId,
      groupId: input.groupId,
      createdBy: input.createdBy,
      mediaUrl: input.mediaUrl,
      mediaType: input.mediaType,
      caption: input.caption ?? null,
      views: 0,
      expiresAt,
      createdAt: input.now,
    });
  }

  static fromState(s: GroupStoryState): GroupStory {
    return new GroupStory({ ...s });
  }

  toState(): GroupStoryState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }
  get kindergartenId(): string {
    return this.state.kindergartenId;
  }
  get groupId(): string {
    return this.state.groupId;
  }
  get createdBy(): string {
    return this.state.createdBy;
  }
  get mediaUrl(): string {
    return this.state.mediaUrl;
  }
  get mediaType(): StoryMediaType {
    return this.state.mediaType;
  }
  get caption(): string | null {
    return this.state.caption;
  }
  get views(): number {
    return this.state.views;
  }
  get expiresAt(): Date {
    return this.state.expiresAt;
  }
  get createdAt(): Date {
    return this.state.createdAt;
  }

  // ── predicates ─────────────────────────────────────────────────────────

  /**
   * `true` iff `now >= expiresAt`. Boundary: a story whose `expiresAt`
   * equals `now` to the millisecond is considered expired (safer to expire
   * a hair early than to leak a stale story).
   */
  isExpired(now: Date): boolean {
    return now.getTime() >= this.state.expiresAt.getTime();
  }

  /**
   * Throws `GroupStoryExpiredError` if `isExpired(now)` is true.
   * Service should call this before serving a story to a parent.
   */
  assertNotExpired(now: Date): void {
    if (this.isExpired(now)) {
      throw new GroupStoryExpiredError(this.state.id, this.state.expiresAt);
    }
  }

  /**
   * Authorisation predicate: a story can be deleted by its author OR by a
   * kindergarten admin. Mentors and specialists who did not author the
   * story cannot delete it.
   *
   * The role string convention matches the rest of the codebase
   * (`'admin'`, `'mentor'`, `'specialist'`, `'parent'`, …).
   */
  canBeDeletedBy(actor: StoryActor): boolean {
    if (actor.userId === this.state.createdBy) return true;
    if (actor.role === 'admin') return true;
    return false;
  }

  // ── mutators ───────────────────────────────────────────────────────────

  /**
   * Increment the in-memory views counter. Service may also issue an atomic
   * `UPDATE … SET views = views + 1` directly against the DB to avoid a
   * read-modify-write race; this method exists so unit tests and any
   * single-writer code paths stay consistent.
   */
  incrementViews(): void {
    this.state.views += 1;
  }
}
