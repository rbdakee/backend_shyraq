import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { ContentPostStatusInvalidError } from '../errors/content-post-status-invalid.error';
import { ContentTargetInvalidError } from '../errors/content-target-invalid.error';

/**
 * Catalogue of content kinds supported by §9 Content Management.
 *
 *   - `news`         — news/announcement (§9.1)
 *   - `menu`         — narrative menu post (§9.2 has structured `meal_plans`
 *                      table for the canonical menu data; this is the
 *                      free-form *announcement* about a menu change)
 *   - `schedule_pub` — narrative schedule post (parallel to `menu`)
 *   - `qundylyq`     — monthly value/theme post (§9.4)
 *   - `birthday`     — auto-generated birthday greeting (§9.5)
 */
export type ContentType =
  | 'news'
  | 'menu'
  | 'schedule_pub'
  | 'qundylyq'
  | 'birthday';

const KNOWN_CONTENT_TYPES: ReadonlySet<ContentType> = new Set([
  'news',
  'menu',
  'schedule_pub',
  'qundylyq',
  'birthday',
]);

/**
 * Targeting mode — mirrors the DB enum `content_target_type` and the
 * `content_posts_target_invariant_check` constraint:
 *
 *   - `all`   → both `targetGroupId` and `targetChildId` are null
 *   - `group` → `targetGroupId` non-null, `targetChildId` null
 *   - `child` → `targetChildId` non-null, `targetGroupId` null
 */
export type ContentTargetType = 'all' | 'group' | 'child';

const KNOWN_TARGET_TYPES: ReadonlySet<ContentTargetType> = new Set([
  'all',
  'group',
  'child',
]);

/**
 * State machine — only forward; `published` is terminal (BP §9.1):
 *   draft → scheduled → published
 *   draft → published (immediate)
 *
 * `scheduled → draft` (un-schedule) is intentionally NOT supported — if
 * product calls for it later we add a method, but the migration models
 * forward-only by default.
 */
export type ContentStatus = 'draft' | 'scheduled' | 'published';

/**
 * Localised text blob — caller-controlled key set (typically `{ ru, kk }`).
 * Stored verbatim as JSONB; the entity does not enforce a particular shape.
 */
export type LocalisedText = Record<string, string>;

export interface ContentPostState {
  id: string;
  kindergartenId: string;
  contentType: ContentType;
  targetType: ContentTargetType;
  targetGroupId: string | null;
  targetChildId: string | null;
  /** Legacy single-locale title — kept for backwards compatibility with pre-i18n posts. */
  title: string | null;
  /** Legacy single-locale body. */
  body: string | null;
  titleI18n: LocalisedText | null;
  bodyI18n: LocalisedText | null;
  mediaUrls: string[] | null;
  metadata: Record<string, unknown> | null;
  scheduledFor: Date | null;
  publishedAt: Date | null;
  expiresAt: Date | null;
  status: ContentStatus;
  /** users.id of the human author; `null` for system-generated (e.g. birthday cron). */
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Input shape for `ContentPost.create`. Most fields are optional; required
 * are `id`, `kindergartenId`, `contentType`, `targetType`. Target-shape is
 * validated via the same path as `fromState` (DB-CHECK parity).
 *
 * If `scheduledFor` is provided, status starts as `'scheduled'` (and the
 * date must be strictly in the future). Otherwise status starts as `'draft'`.
 *
 * Note for the qundylyq flow (§9.4): callers pass
 *   `{ contentType: 'qundylyq', targetType: 'all', metadata: { month, theme } }`
 * — there is no separate factory because the differentiation lives entirely
 * in metadata + i18n title/body.
 */
export interface ContentPostCreateInput {
  id: string;
  kindergartenId: string;
  contentType: ContentType;
  targetType: ContentTargetType;
  targetGroupId?: string | null;
  targetChildId?: string | null;
  title?: string | null;
  body?: string | null;
  titleI18n?: LocalisedText | null;
  bodyI18n?: LocalisedText | null;
  mediaUrls?: string[] | null;
  metadata?: Record<string, unknown> | null;
  scheduledFor?: Date | null;
  expiresAt?: Date | null;
  createdBy?: string | null;
  now: Date;
}

/**
 * Input for the auto-generated birthday greeting (§9.5). Cron task
 * `birthday-generation` calls this daily at 07:00 Asia/Almaty. Idempotency
 * (no duplicate post for the same child on the same day) is enforced at the
 * service layer via `metadata.child_id` lookup, not at the entity layer.
 */
export interface ContentPostCreateBirthdayInput {
  id: string;
  kindergartenId: string;
  targetChildId: string;
  childFullName: string;
  /** Age the child is turning today, in years. */
  childAge: number;
  now: Date;
}

/**
 * Patch payload for `ContentPost.update`. All fields are optional; only the
 * keys that are present (i.e. `key in payload`) get applied. `null` is a
 * meaningful value (clear-the-field) for the nullable columns.
 *
 * Notes:
 *   - `contentType` is intentionally *not* mutable post-creation — see the
 *     `update()` body which throws `content_type_immutable` if a caller ever
 *     sneaks one in via Object.assign-style merges. The TS type prevents the
 *     happy path.
 *   - `scheduledFor` mutation is only allowed when `status === 'scheduled'`
 *     and the new value is strictly in the future.
 *   - Mutating `targetType`/`targetGroupId`/`targetChildId` triggers a
 *     re-validation of the target invariant; partial patches that leave the
 *     aggregate in an invalid shape throw `ContentTargetInvalidError`.
 */
export interface ContentPostUpdatePayload {
  title?: string | null;
  body?: string | null;
  titleI18n?: LocalisedText | null;
  bodyI18n?: LocalisedText | null;
  mediaUrls?: string[] | null;
  metadata?: Record<string, unknown> | null;
  expiresAt?: Date | null;
  targetType?: ContentTargetType;
  targetGroupId?: string | null;
  targetChildId?: string | null;
  scheduledFor?: Date | null;
}

/**
 * Validates the (targetType, targetGroupId, targetChildId) triple against the
 * DB CHECK constraint. Throws on violation. Pure function — no side effects.
 */
function validateTargetShape(
  targetType: ContentTargetType,
  targetGroupId: string | null,
  targetChildId: string | null,
): void {
  if (!KNOWN_TARGET_TYPES.has(targetType)) {
    throw new ContentTargetInvalidError(targetType, 'unknown_target_type');
  }
  if (targetType === 'all') {
    if (targetGroupId !== null || targetChildId !== null) {
      throw new ContentTargetInvalidError(
        targetType,
        'target_ids_must_be_empty',
      );
    }
    return;
  }
  if (targetType === 'group') {
    if (targetGroupId === null) {
      throw new ContentTargetInvalidError(
        targetType,
        'target_group_id_required',
      );
    }
    if (targetChildId !== null) {
      throw new ContentTargetInvalidError(
        targetType,
        'target_ids_mutually_exclusive',
      );
    }
    return;
  }
  // targetType === 'child'
  if (targetChildId === null) {
    throw new ContentTargetInvalidError(targetType, 'target_child_id_required');
  }
  if (targetGroupId !== null) {
    throw new ContentTargetInvalidError(
      targetType,
      'target_ids_mutually_exclusive',
    );
  }
}

/**
 * ContentPost aggregate (B17 §9). Owns the state machine
 *
 *   draft     ──schedule──►  scheduled
 *   draft     ──publish───►  published
 *   scheduled ──publish───►  published
 *
 * `published` is terminal — `schedule()`, `publish()`, `update()` and
 * `delete` (via `canDelete()` guard) all reject.
 *
 * Invariants enforced by the constructor (so DB-row hydration that has been
 * corrupted manually fails fast):
 *   - `contentType` ∈ KNOWN_CONTENT_TYPES
 *   - target-shape matches the DB CHECK constraint
 *
 * Mutability rules:
 *   - `contentType` is fixed at creation (a draft news cannot become a draft
 *     birthday). `update()` throws `content_type_immutable` if caller bypasses
 *     the TS type via dynamic mutation.
 *   - `update()` is allowed only from `draft` or `scheduled`.
 *   - `delete` (via service) is allowed only from `draft`.
 */
export class ContentPost {
  private constructor(private state: ContentPostState) {
    if (!KNOWN_CONTENT_TYPES.has(state.contentType)) {
      // Defensive — DB enum already prevents this hydration, but a corrupted
      // payload from an integration test or CLI script should fail fast with
      // a generic 400. (Adding a dedicated `ContentTypeInvalidError` would be
      // overkill for a branch the strict-mode TS compiler already excludes.)
      throw new InvariantViolationError('content_type_invalid');
    }
    validateTargetShape(
      state.targetType,
      state.targetGroupId,
      state.targetChildId,
    );
  }

  // ── factories ──────────────────────────────────────────────────────────

  /**
   * Create a brand-new ContentPost. If `scheduledFor` is provided and is
   * strictly in the future, the post starts in `'scheduled'`; otherwise
   * `'draft'`. Use `publish()` for immediate publication after creation.
   */
  static create(input: ContentPostCreateInput): ContentPost {
    const targetGroupId = input.targetGroupId ?? null;
    const targetChildId = input.targetChildId ?? null;

    // Validate target shape early — better error than letting fromState
    // throw with less context.
    validateTargetShape(input.targetType, targetGroupId, targetChildId);

    const status: ContentStatus =
      input.scheduledFor !== undefined && input.scheduledFor !== null
        ? 'scheduled'
        : 'draft';

    if (status === 'scheduled') {
      // Non-null assertion is safe: the branch condition guarantees it.
      const sched = input.scheduledFor as Date;
      if (sched.getTime() <= input.now.getTime()) {
        throw new ContentPostStatusInvalidError(
          'draft',
          'create',
          'content_scheduled_for_in_past',
        );
      }
    }

    return new ContentPost({
      id: input.id,
      kindergartenId: input.kindergartenId,
      contentType: input.contentType,
      targetType: input.targetType,
      targetGroupId,
      targetChildId,
      title: input.title ?? null,
      body: input.body ?? null,
      titleI18n: input.titleI18n ?? null,
      bodyI18n: input.bodyI18n ?? null,
      mediaUrls: input.mediaUrls ?? null,
      metadata: input.metadata ?? null,
      scheduledFor: input.scheduledFor ?? null,
      publishedAt: null,
      expiresAt: input.expiresAt ?? null,
      status,
      createdBy: input.createdBy ?? null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  /**
   * Auto-generate a birthday greeting (§9.5). Status starts as `'published'`
   * (cron auto-publishes); `createdBy=null` (system-generated). Idempotency
   * is enforced by the service layer via `metadata.child_id` lookup.
   */
  static createBirthday(input: ContentPostCreateBirthdayInput): ContentPost {
    const titleI18n: LocalisedText = {
      ru: `С днём рождения, ${input.childFullName}!`,
      kk: `Туған күніңмен, ${input.childFullName}!`,
    };
    const bodyI18n: LocalisedText = {
      ru: `Поздравляем с ${input.childAge}-летием!`,
      kk: `${input.childAge} жасыңмен құттықтаймыз!`,
    };

    return new ContentPost({
      id: input.id,
      kindergartenId: input.kindergartenId,
      contentType: 'birthday',
      targetType: 'child',
      targetGroupId: null,
      targetChildId: input.targetChildId,
      title: null,
      body: null,
      titleI18n,
      bodyI18n,
      mediaUrls: null,
      metadata: { child_id: input.targetChildId, age: input.childAge },
      scheduledFor: null,
      publishedAt: input.now,
      expiresAt: null,
      status: 'published',
      createdBy: null,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static fromState(s: ContentPostState): ContentPost {
    return new ContentPost({ ...s });
  }

  toState(): ContentPostState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }
  get kindergartenId(): string {
    return this.state.kindergartenId;
  }
  get contentType(): ContentType {
    return this.state.contentType;
  }
  get targetType(): ContentTargetType {
    return this.state.targetType;
  }
  get targetGroupId(): string | null {
    return this.state.targetGroupId;
  }
  get targetChildId(): string | null {
    return this.state.targetChildId;
  }
  get title(): string | null {
    return this.state.title;
  }
  get body(): string | null {
    return this.state.body;
  }
  get titleI18n(): LocalisedText | null {
    return this.state.titleI18n;
  }
  get bodyI18n(): LocalisedText | null {
    return this.state.bodyI18n;
  }
  get mediaUrls(): string[] | null {
    return this.state.mediaUrls;
  }
  get metadata(): Record<string, unknown> | null {
    return this.state.metadata;
  }
  get scheduledFor(): Date | null {
    return this.state.scheduledFor;
  }
  get publishedAt(): Date | null {
    return this.state.publishedAt;
  }
  get expiresAt(): Date | null {
    return this.state.expiresAt;
  }
  get status(): ContentStatus {
    return this.state.status;
  }
  get createdBy(): string | null {
    return this.state.createdBy;
  }
  get createdAt(): Date {
    return this.state.createdAt;
  }
  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── predicates ─────────────────────────────────────────────────────────

  /** `true` iff the post is in `draft` — only deletable origin status. */
  canDelete(): boolean {
    return this.state.status === 'draft';
  }

  /** `true` iff the post can still be edited (`draft` or `scheduled`). */
  canEdit(): boolean {
    return this.state.status === 'draft' || this.state.status === 'scheduled';
  }

  isPublished(): boolean {
    return this.state.status === 'published';
  }

  // ── transitions ────────────────────────────────────────────────────────

  /**
   * `draft → scheduled`. Requires `scheduledFor` strictly in the future.
   * Rejects from `scheduled` (already scheduled — use `update()` to change
   * the date) and from `published` (terminal).
   */
  schedule(scheduledFor: Date, now: Date): void {
    if (this.state.status === 'published') {
      throw new ContentPostStatusInvalidError(
        this.state.status,
        'schedule',
        'content_already_published',
      );
    }
    if (this.state.status !== 'draft') {
      throw new ContentPostStatusInvalidError(
        this.state.status,
        'schedule',
        'wrong_source_status',
      );
    }
    if (scheduledFor.getTime() <= now.getTime()) {
      throw new ContentPostStatusInvalidError(
        this.state.status,
        'schedule',
        'content_scheduled_for_in_past',
      );
    }
    this.state.status = 'scheduled';
    this.state.scheduledFor = scheduledFor;
    this.state.updatedAt = now;
  }

  /**
   * `draft → published` (immediate) OR `scheduled → published` (cron or
   * manual). Sets `publishedAt = now`. Rejects from `published` (terminal).
   */
  publish(now: Date): void {
    if (this.state.status === 'published') {
      throw new ContentPostStatusInvalidError(
        this.state.status,
        'publish',
        'content_already_published',
      );
    }
    if (this.state.status !== 'draft' && this.state.status !== 'scheduled') {
      // Defensive — the union already only has draft|scheduled|published, so
      // this branch is unreachable in well-typed code. Kept for hydrated-row
      // robustness.
      throw new ContentPostStatusInvalidError(
        this.state.status,
        'publish',
        'wrong_source_status',
      );
    }
    this.state.status = 'published';
    this.state.publishedAt = now;
    this.state.updatedAt = now;
  }

  /**
   * Patch mutable fields. Allowed only from `draft` or `scheduled`.
   *
   * Behaviour:
   *   - Only keys *present* in `payload` are applied (including those set to
   *     `null` to clear the field). Missing keys leave the existing value.
   *   - `contentType` is not in the patch type, but if a malicious caller
   *     bypasses TS and injects one, throws `content_type_immutable`.
   *   - Mutating any of `targetType`/`targetGroupId`/`targetChildId`
   *     re-validates the target invariant *after* the patch is applied.
   *   - `scheduledFor` mutation is only allowed when `status === 'scheduled'`
   *     and the new value is strictly in the future.
   */
  update(payload: ContentPostUpdatePayload, now: Date): void {
    if (this.state.status === 'published') {
      throw new ContentPostStatusInvalidError(
        this.state.status,
        'update',
        'content_already_published',
      );
    }
    if (!this.canEdit()) {
      // Defensive — only draft|scheduled remain after the published branch.
      throw new ContentPostStatusInvalidError(
        this.state.status,
        'update',
        'wrong_source_status',
      );
    }

    // Defence-in-depth against dynamic injection of contentType. The static
    // type forbids it; this is a runtime check for hydrated payloads from
    // untrusted boundaries (e.g. an admin API mistakenly forwarding the full
    // body to update()).
    if (
      Object.prototype.hasOwnProperty.call(
        payload as Record<string, unknown>,
        'contentType',
      )
    ) {
      throw new ContentPostStatusInvalidError(
        this.state.status,
        'update',
        'content_type_immutable',
      );
    }

    if ('title' in payload) this.state.title = payload.title ?? null;
    if ('body' in payload) this.state.body = payload.body ?? null;
    if ('titleI18n' in payload)
      this.state.titleI18n = payload.titleI18n ?? null;
    if ('bodyI18n' in payload) this.state.bodyI18n = payload.bodyI18n ?? null;
    if ('mediaUrls' in payload)
      this.state.mediaUrls = payload.mediaUrls ?? null;
    if ('metadata' in payload) this.state.metadata = payload.metadata ?? null;
    if ('expiresAt' in payload)
      this.state.expiresAt = payload.expiresAt ?? null;

    // Target patch — apply provisionally, then re-validate. We must fold all
    // three fields together because partial patches need the *resulting*
    // triple to be valid.
    const targetPatched =
      'targetType' in payload ||
      'targetGroupId' in payload ||
      'targetChildId' in payload;
    if (targetPatched) {
      const nextType =
        'targetType' in payload && payload.targetType !== undefined
          ? payload.targetType
          : this.state.targetType;
      const nextGroupId =
        'targetGroupId' in payload
          ? (payload.targetGroupId ?? null)
          : this.state.targetGroupId;
      const nextChildId =
        'targetChildId' in payload
          ? (payload.targetChildId ?? null)
          : this.state.targetChildId;
      validateTargetShape(nextType, nextGroupId, nextChildId);
      this.state.targetType = nextType;
      this.state.targetGroupId = nextGroupId;
      this.state.targetChildId = nextChildId;
    }

    if ('scheduledFor' in payload) {
      const next = payload.scheduledFor ?? null;
      if (next === null) {
        // Clearing scheduledFor on a scheduled post would leave it without
        // a publish date — disallow. Callers that want to "unschedule" must
        // transition back to draft, which we don't support.
        throw new ContentPostStatusInvalidError(
          this.state.status,
          'update',
          'wrong_source_status',
        );
      }
      if (this.state.status !== 'scheduled') {
        // Patching scheduledFor on a draft makes no sense — scheduling is
        // its own transition (`schedule()`). Reject to surface the contract.
        throw new ContentPostStatusInvalidError(
          this.state.status,
          'update',
          'wrong_source_status',
        );
      }
      if (next.getTime() <= now.getTime()) {
        throw new ContentPostStatusInvalidError(
          this.state.status,
          'update',
          'content_scheduled_for_in_past',
        );
      }
      this.state.scheduledFor = next;
    }

    this.state.updatedAt = now;
  }
}
