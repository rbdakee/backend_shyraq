import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { tenantStorage } from '@/database/tenant-storage';
import { ContentRepository, ListContentFilters } from './content.repository';
import {
  ContentPost,
  ContentStatus,
  ContentTargetType,
  ContentType,
  LocalisedText,
} from './domain/entities/content-post.entity';
import { ContentPostNotFoundError } from './domain/errors/content-post-not-found.error';
import { ContentPostStatusInvalidError } from './domain/errors/content-post-status-invalid.error';
import { FileUploadError } from './domain/errors/file-upload.error';
import { MediaTypeInvalidError } from './domain/errors/media-type-invalid.error';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';

/**
 * DTO-shaped input the controller layer hands the service. Service does
 * NOT depend on `class-validator` — the controller validates first.
 */
export interface CreateContentInput {
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
}

export interface UpdateContentInput {
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

export interface UploadMediaInput {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

export interface UploadMediaResult {
  url: string;
  key: string;
}

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * Maps `content_type` to its outbox event-key used by the dispatcher.
 * `menu` and `schedule_pub` do not (yet) ship a notification template —
 * they're surfaced through the parent feed only.
 */
function eventKeyForContentType(t: ContentType): string | null {
  switch (t) {
    case 'news':
      return 'content.news_published';
    case 'qundylyq':
      return 'content.qundylyq_new';
    case 'birthday':
      return 'content.birthday';
    default:
      return null;
  }
}

/**
 * ContentService — admin CRUD + state machine for `content_posts` (B17 §9).
 *
 * State machine is enforced both at the entity level (for the in-memory
 * read-modify-write happy path) AND at the persistence edge via
 * `ContentRepository.transitionStatus` (conditional UPDATE WHERE status=expected
 * RETURNING *) so concurrent writers serialise without corrupting state.
 *
 * Transitions:
 *   draft     ──schedule──►  scheduled        // via `schedule(...)`
 *   draft     ──publish───►  published        // via `publish(...)`
 *   scheduled ──publish───►  published        // via `publish(...)` or cron
 *
 * Publishing emits a `content.<type>_published` outbox event in the SAME
 * TX so a downstream rollback (notification fan-out failure, etc.) leaves
 * the row in `scheduled`.
 *
 * `delete` is allowed only from `draft` (entity guard `canDelete()`); the
 * service walks `mediaUrls` and best-effort-deletes the underlying
 * storage objects (logged on failure, never blocks the SQL DELETE).
 */
@Injectable()
export class ContentService {
  private readonly logger = new Logger(ContentService.name);

  constructor(
    private readonly contentRepo: ContentRepository,
    private readonly groupRepo: GroupRepository,
    private readonly childRepo: ChildRepository,
    private readonly fileStorage: FileStoragePort,
    private readonly notificationPort: NotificationPort,
    private readonly dataSource: DataSource,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  // ── CRUD ───────────────────────────────────────────────────────────────

  async create(
    kindergartenId: string,
    input: CreateContentInput,
    createdBy: string | null,
  ): Promise<ContentPost> {
    await this.assertTargetBelongsToKg(kindergartenId, {
      targetType: input.targetType,
      targetGroupId: input.targetGroupId ?? null,
      targetChildId: input.targetChildId ?? null,
    });

    const now = this.clock.now();
    const post = ContentPost.create({
      id: randomUUID(),
      kindergartenId,
      contentType: input.contentType,
      targetType: input.targetType,
      targetGroupId: input.targetGroupId ?? null,
      targetChildId: input.targetChildId ?? null,
      title: input.title ?? null,
      body: input.body ?? null,
      titleI18n: input.titleI18n ?? null,
      bodyI18n: input.bodyI18n ?? null,
      mediaUrls: input.mediaUrls ?? null,
      metadata: input.metadata ?? null,
      scheduledFor: input.scheduledFor ?? null,
      expiresAt: input.expiresAt ?? null,
      createdBy,
      now,
    });
    return this.contentRepo.create(post);
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateContentInput,
  ): Promise<ContentPost> {
    const post = await this.contentRepo.findById(kindergartenId, id);
    if (!post) throw new ContentPostNotFoundError(id);

    const targetPatched =
      patch.targetType !== undefined ||
      'targetGroupId' in patch ||
      'targetChildId' in patch;
    if (targetPatched) {
      const nextType = patch.targetType ?? post.targetType;
      const nextGroup =
        'targetGroupId' in patch
          ? (patch.targetGroupId ?? null)
          : post.targetGroupId;
      const nextChild =
        'targetChildId' in patch
          ? (patch.targetChildId ?? null)
          : post.targetChildId;
      await this.assertTargetBelongsToKg(kindergartenId, {
        targetType: nextType,
        targetGroupId: nextGroup,
        targetChildId: nextChild,
      });
    }

    const now = this.clock.now();
    post.update(patch, now);
    return this.contentRepo.update(post);
  }

  async delete(kindergartenId: string, id: string): Promise<void> {
    const post = await this.contentRepo.findById(kindergartenId, id);
    if (!post) throw new ContentPostNotFoundError(id);
    if (!post.canDelete()) {
      throw new ContentPostStatusInvalidError(
        post.status,
        'delete',
        'content_cannot_delete_published',
      );
    }
    const deleted = await this.contentRepo.delete(kindergartenId, id);
    if (!deleted) {
      // Lost a race with another deleter — treat as 404 to be helpful.
      throw new ContentPostNotFoundError(id);
    }

    // Best-effort: walk mediaUrls and call FileStoragePort.delete(key).
    // Storage failures are logged and do NOT roll back the SQL DELETE.
    const urls = post.mediaUrls ?? [];
    for (const url of urls) {
      const key = extractKeyFromUrl(url);
      if (!key) continue;
      try {
        await this.fileStorage.delete(key);
      } catch (err) {
        this.logger.warn(
          `media_delete_failed key=${key}: ${(err as Error).message}`,
        );
      }
    }
  }

  // ── transitions ────────────────────────────────────────────────────────

  async schedule(
    kindergartenId: string,
    id: string,
    scheduledFor: Date,
  ): Promise<ContentPost> {
    const post = await this.contentRepo.findById(kindergartenId, id);
    if (!post) throw new ContentPostNotFoundError(id);
    const now = this.clock.now();
    // Capture original status BEFORE the entity validates + mutates so
    // the conditional UPDATE WHERE status=$expected uses the pre-mutation
    // value. Do not call `post.schedule` directly on `post` — it would
    // mutate the in-memory aggregate; we re-derive the entity-side
    // validation by attempting a temporary clone-style schedule on a
    // detached state copy. (Practical effect: same domain validation,
    // no shared-state side effect on the original.)
    const expectedStatus: ContentStatus = post.status;
    const probe = ContentPost.fromState({ ...post.toState() });
    probe.schedule(scheduledFor, now); // throws on invariant violation
    const updated = await this.contentRepo.transitionStatus(
      kindergartenId,
      id,
      expectedStatus,
      'scheduled',
      { scheduledFor, updatedAt: now },
    );
    if (!updated) {
      throw new ContentPostStatusInvalidError(
        expectedStatus,
        'schedule',
        'wrong_source_status',
      );
    }
    return updated;
  }

  /**
   * `draft|scheduled → published`. Emits a `content.*_published` outbox
   * event in the same TX so the notification fan-out is atomic with the
   * status flip.
   */
  async publish(kindergartenId: string, id: string): Promise<ContentPost> {
    const post = await this.contentRepo.findById(kindergartenId, id);
    if (!post) throw new ContentPostNotFoundError(id);

    const now = this.clock.now();
    const expectedStatus: ContentStatus = post.status;
    if (expectedStatus !== 'draft' && expectedStatus !== 'scheduled') {
      throw new ContentPostStatusInvalidError(
        expectedStatus,
        'publish',
        'content_already_published',
      );
    }

    return this.runInTenantTx(kindergartenId, async () => {
      const updated = await this.contentRepo.transitionStatus(
        kindergartenId,
        id,
        expectedStatus,
        'published',
        { publishedAt: now, updatedAt: now },
      );
      if (!updated) {
        throw new ContentPostStatusInvalidError(
          expectedStatus,
          'publish',
          'wrong_source_status',
        );
      }
      await this.emitPublishedEvent(updated, now);
      return updated;
    });
  }

  // ── reads ──────────────────────────────────────────────────────────────

  list(
    kindergartenId: string,
    filters: ListContentFilters,
  ): Promise<ContentPost[]> {
    return this.contentRepo.list(kindergartenId, filters);
  }

  async getById(kindergartenId: string, id: string): Promise<ContentPost> {
    const post = await this.contentRepo.findById(kindergartenId, id);
    if (!post) throw new ContentPostNotFoundError(id);
    return post;
  }

  // ── media upload ───────────────────────────────────────────────────────

  /**
   * Uploads a single media file under
   * `<kgId>/<yyyy-mm>/<uuid>.<ext>`. Validates mimetype against
   * `image/*` and `video/*`; rejects everything else with
   * `MediaTypeInvalidError`.
   *
   * Phase A: max 10 MB for images and 100 MB for videos. The controller
   * may apply tighter caps via `multer`.
   */
  async uploadMedia(
    kindergartenId: string,
    file: UploadMediaInput,
  ): Promise<UploadMediaResult> {
    if (!file.buffer || file.buffer.length === 0) {
      throw new FileUploadError('upload_failed', 'empty_buffer');
    }
    const mt = (file.mimetype ?? '').toLowerCase();
    if (!mt.startsWith('image/') && !mt.startsWith('video/')) {
      throw new MediaTypeInvalidError(mt);
    }
    const maxBytes = mt.startsWith('video/')
      ? DEFAULT_MAX_VIDEO_BYTES
      : DEFAULT_MAX_IMAGE_BYTES;
    if (file.buffer.length > maxBytes) {
      throw new FileUploadError('file_too_large');
    }

    const now = this.clock.now();
    const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
    const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    const ext = (extname(file.originalname || '') || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
    const key = `${kindergartenId}/${yyyy}-${mm}/${randomUUID()}${safeExt}`;

    const result = await this.fileStorage.upload({
      buffer: file.buffer,
      key,
      contentType: mt,
      maxBytes,
    });
    return { url: result.url, key: result.key };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /**
   * Defence-in-depth cross-tenant check: the entity already validates the
   * (targetType, targetGroupId, targetChildId) shape, but it does NOT
   * know whether those ids live in this kg. A malicious admin could craft
   * a payload pointing at a different kg's group — the RLS policy would
   * accept the INSERT (kindergarten_id is ours), and at-feed-time the
   * parent app would attempt to render a phantom group. We close the
   * hole here.
   */
  private async assertTargetBelongsToKg(
    kindergartenId: string,
    target: {
      targetType: ContentTargetType;
      targetGroupId: string | null;
      targetChildId: string | null;
    },
  ): Promise<void> {
    if (target.targetType === 'group' && target.targetGroupId) {
      const group = await this.groupRepo.findById(
        kindergartenId,
        target.targetGroupId,
      );
      if (!group) throw new GroupNotFoundError(target.targetGroupId);
    }
    if (target.targetType === 'child' && target.targetChildId) {
      const child = await this.childRepo.findById(
        kindergartenId,
        target.targetChildId,
      );
      if (!child) throw new ChildNotFoundError(target.targetChildId);
    }
  }

  private async emitPublishedEvent(
    post: ContentPost,
    now: Date,
  ): Promise<void> {
    const eventKey = eventKeyForContentType(post.contentType);
    if (!eventKey) return;

    if (eventKey === 'content.news_published') {
      await this.notificationPort.notifyContentNewsPublished({
        kindergartenId: post.kindergartenId,
        contentPostId: post.id,
        targetType: post.targetType,
        targetGroupId: post.targetGroupId,
        targetChildId: post.targetChildId,
        titleI18n: post.titleI18n,
        publishedAt: post.publishedAt ?? now,
      });
      return;
    }
    if (eventKey === 'content.qundylyq_new') {
      await this.notificationPort.notifyContentQundylyqNew({
        kindergartenId: post.kindergartenId,
        contentPostId: post.id,
        titleI18n: post.titleI18n,
        metadata: post.metadata,
        publishedAt: post.publishedAt ?? now,
      });
      return;
    }
    if (eventKey === 'content.birthday') {
      const childId = post.targetChildId ?? '';
      const meta = (post.metadata ?? {}) as Record<string, unknown>;
      const fullName =
        typeof meta.child_full_name === 'string' &&
        meta.child_full_name.length > 0
          ? meta.child_full_name
          : pickName(post.titleI18n);
      const age = typeof meta.age === 'number' ? meta.age : 0;
      await this.notificationPort.notifyContentBirthday({
        kindergartenId: post.kindergartenId,
        contentPostId: post.id,
        targetChildId: childId,
        childFullName: fullName,
        age,
        publishedAt: post.publishedAt ?? now,
      });
    }
  }

  /**
   * Wraps `fn` in a tenant-scoped TX if the caller is not already inside
   * one. The HTTP pipeline (`TenantContextInterceptor`) already opens a
   * tenant TX, in which case we re-use it via `tenantStorage`. Cron /
   * processor callers without ambient tenant context open a fresh TX
   * and publish via `tenantStorage.run`.
   */
  private async runInTenantTx<T>(
    kindergartenId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const ambient = tenantStorage.getStore();
    if (ambient?.entityManager) {
      // Already in a tenant TX — the outbox repo will pick up the same EM.
      return fn();
    }
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      return tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        () => fn(),
      );
    });
  }
}

function extractKeyFromUrl(url: string): string | null {
  if (!url) return null;
  // Local adapter: `/api/v1/media/<key>` — strip the prefix.
  const m = url.match(/^\/api\/v1\/media\/(.+)$/);
  if (m) return m[1];
  // S3 / CDN URLs (Phase B) — caller can pass through the raw key field
  // separately; for now we don't try to reverse-engineer a key from a
  // CDN URL. Returning null skips the storage delete (the file lives
  // until the bucket-level lifecycle rule sweeps it).
  return null;
}

function pickName(i18n: LocalisedText | null): string {
  if (!i18n) return '';
  return i18n.ru ?? i18n.kz ?? i18n.kk ?? i18n.en ?? '';
}
