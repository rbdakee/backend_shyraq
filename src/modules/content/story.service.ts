import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TransactionRunnerPort } from '@/shared-kernel/application/ports/transaction-runner.port';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import { tenantStorage } from '@/database/tenant-storage';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import {
  GroupStory,
  StoryActor,
  StoryMediaType,
} from './domain/entities/group-story.entity';
import { FileUploadError } from './domain/errors/file-upload.error';
import { GroupStoryNotFoundError } from './domain/errors/group-story-not-found.error';
import { MediaTypeInvalidError } from './domain/errors/media-type-invalid.error';
import { GroupStoryRepository } from './group-story.repository';

export interface StoryCreateInput {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  caption?: string | null;
}

const STORY_MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const STORY_MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100 MB

/**
 * StoryService — multipart upload + 24h ephemeral story management
 * (BP §9.6).
 *
 *   - `create` validates the group belongs to the kg, classifies the
 *     mimetype into `image|video`, uploads the bytes via
 *     `FileStoragePort`, builds the `GroupStory` aggregate, persists it
 *     and emits `content.story_new` in the same TX.
 *
 *   - `delete` is allowed for the author OR for kindergarten admins
 *     (entity predicate `canBeDeletedBy`). Storage cleanup is
 *     best-effort.
 *
 *   - `incrementViews` issues an atomic `UPDATE views = views + 1
 *     RETURNING true` so concurrent reads stay race-free.
 *
 * Stories ship with a 24h TTL set by the entity factory; the
 * `story-cleanup` cron sweeps expired rows hourly.
 */
@Injectable()
export class StoryService {
  private readonly logger = new Logger(StoryService.name);

  constructor(
    private readonly storyRepo: GroupStoryRepository,
    private readonly groupRepo: GroupRepository,
    private readonly fileStorage: FileStoragePort,
    private readonly notificationPort: NotificationPort,
    @Inject(TransactionRunnerPort)
    private readonly tx: TransactionRunnerPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    private readonly childRepo: ChildRepository,
    private readonly childGuardianRepo: ChildGuardianRepository,
  ) {}

  async create(
    kindergartenId: string,
    groupId: string,
    createdBy: string,
    media: StoryCreateInput,
    actor?: { userId: string; role: string },
  ): Promise<GroupStory> {
    const group = await this.groupRepo.findById(kindergartenId, groupId);
    if (!group) throw new GroupNotFoundError(groupId);

    // B17 T8 HIGH#3 — mentor must be actively assigned to this group; admin
    // bypasses. Other roles (super_admin/system) also bypass when actor is
    // not provided (cron / batch callers without an HTTP actor).
    if (actor && actor.role === 'mentor') {
      const isAssigned = await this.groupRepo.isUserActiveMentorForGroup(
        kindergartenId,
        actor.userId,
        groupId,
      );
      if (!isAssigned) {
        throw new ForbiddenActionError(
          'mentor_not_assigned_to_group',
          'Mentor is not assigned to this group',
        );
      }
    }

    if (!media.buffer || media.buffer.length === 0) {
      throw new FileUploadError('upload_failed', 'empty_buffer');
    }
    const mt = (media.mimetype ?? '').toLowerCase();
    const mediaType = classifyMediaType(mt);
    const maxBytes =
      mediaType === 'video' ? STORY_MAX_VIDEO_BYTES : STORY_MAX_IMAGE_BYTES;
    if (media.buffer.length > maxBytes) {
      throw new FileUploadError('file_too_large');
    }

    const now = this.clock.now();
    const yyyy = now.getUTCFullYear().toString().padStart(4, '0');
    const mm = (now.getUTCMonth() + 1).toString().padStart(2, '0');
    const ext = (extname(media.originalname || '') || '').toLowerCase();
    const safeExt = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '';
    const key = `${kindergartenId}/stories/${yyyy}-${mm}/${randomUUID()}${safeExt}`;
    const upload = await this.fileStorage.upload({
      buffer: media.buffer,
      key,
      contentType: mt,
      maxBytes,
    });

    const story = GroupStory.create({
      id: randomUUID(),
      kindergartenId,
      groupId,
      createdBy,
      mediaUrl: upload.url,
      mediaType,
      caption: media.caption ?? null,
      now,
    });

    return this.runInTenantTx(kindergartenId, async () => {
      const saved = await this.storyRepo.create(story);
      await this.notificationPort.notifyContentStoryNew({
        kindergartenId,
        storyId: saved.id,
        groupId: saved.groupId,
        mediaUrl: saved.mediaUrl,
        mediaType: saved.mediaType,
        createdBy: saved.createdBy,
        createdAt: saved.createdAt,
      });
      return saved;
    });
  }

  async delete(
    kindergartenId: string,
    storyId: string,
    actor: StoryActor,
  ): Promise<void> {
    const story = await this.storyRepo.findById(kindergartenId, storyId);
    if (!story) throw new GroupStoryNotFoundError(storyId);
    if (!story.canBeDeletedBy(actor)) {
      throw new ForbiddenActionError(
        'story_delete_forbidden',
        'Only the story author or a kindergarten admin can delete this story',
      );
    }

    const deleted = await this.storyRepo.deleteById(kindergartenId, storyId);
    if (!deleted) {
      throw new GroupStoryNotFoundError(storyId);
    }

    const key = extractKeyFromUrl(story.mediaUrl);
    if (key) {
      try {
        await this.fileStorage.delete(key);
      } catch (err) {
        this.logger.warn(
          `story_media_delete_failed key=${key}: ${(err as Error).message}`,
        );
      }
    }
  }

  listActiveByGroup(
    kindergartenId: string,
    groupId: string,
  ): Promise<GroupStory[]> {
    const now = this.clock.now();
    return this.storyRepo.listActiveByGroup(kindergartenId, groupId, now);
  }

  /**
   * Staff-side active-stories list (BP §9.6 / endpoints.md §3.12).
   *
   * Routing matrix:
   *   - `groupIdFilter` set → admin bypass; mentor must be actively
   *     assigned to that group else `ForbiddenActionError`.
   *   - `groupIdFilter` unset + admin → all kg groups, returns active
   *     stories across them all.
   *   - `groupIdFilter` unset + mentor → only the groups this user is an
   *     active mentor of (cross-tenant scoped to the kg) — empty list if
   *     none.
   *
   * Pulled out of `StaffStoriesController` so the controller no longer
   * imports `GroupRepository` / `GroupStoryRepository` directly. The
   * routing was the only reason the controller touched those repos — folding
   * it into the service keeps the role gate and the repo calls together.
   */
  async listActiveForStaff(
    kindergartenId: string,
    actor: { userId: string; role: string },
    groupIdFilter?: string,
  ): Promise<GroupStory[]> {
    const now = this.clock.now();
    if (groupIdFilter) {
      if (actor.role === 'mentor') {
        const isAssigned = await this.groupRepo.isUserActiveMentorForGroup(
          kindergartenId,
          actor.userId,
          groupIdFilter,
        );
        if (!isAssigned) {
          throw new ForbiddenActionError(
            'mentor_not_assigned_to_group',
            'Mentor is not assigned to this group',
          );
        }
      }
      return this.storyRepo.listActiveByGroup(
        kindergartenId,
        groupIdFilter,
        now,
      );
    }

    if (actor.role === 'admin') {
      const groups = await this.groupRepo.list(kindergartenId);
      const groupIds = groups.map((g) => g.id);
      if (groupIds.length === 0) return [];
      return this.storyRepo.listActiveByGroupIds(kindergartenId, groupIds, now);
    }

    // Mentor: find groups assigned to this user in this kg. The
    // cross-tenant helper already filters by `kindergartenId` when
    // provided so this stays kg-scoped.
    const assignments =
      await this.groupRepo.findActiveMentorAssignmentsByUserIdCrossTenant(
        actor.userId,
        kindergartenId,
      );
    if (assignments.length === 0) return [];
    const groupIds = assignments.map((a) => a.groupId);
    return this.storyRepo.listActiveByGroupIds(kindergartenId, groupIds, now);
  }

  /**
   * Increment the story's `views` counter and return the new total in a
   * single service call. Used by the `POST /staff/stories/:id/view`
   * endpoint so the controller no longer needs to call `storyRepo.findById`
   * directly to read back the count.
   */
  async incrementViewsAndGetCount(
    kindergartenId: string,
    storyId: string,
    actor: { userId: string; role: string },
  ): Promise<number> {
    await this.incrementViews(kindergartenId, storyId, actor);
    const story = await this.storyRepo.findById(kindergartenId, storyId);
    return story?.views ?? 0;
  }

  async incrementViews(
    kindergartenId: string,
    storyId: string,
    actor?: { userId: string; role: string },
  ): Promise<void> {
    const story = await this.storyRepo.findById(kindergartenId, storyId);
    if (!story) throw new GroupStoryNotFoundError(storyId);
    const now = this.clock.now();
    story.assertNotExpired(now);

    // B17 T8 MEDIUM#1 — parent must be an approved-active guardian of a
    // child whose current_group_id matches story.groupId. Admin/mentor
    // bypass. (Mentor's own kg-scope guard runs in the controller — we
    // don't re-check assignment here.)
    if (actor && actor.role === 'parent') {
      const guardians = await this.childGuardianRepo.findApprovedByUser(
        kindergartenId,
        actor.userId,
      );
      const childIds = guardians.map((g) => g.toState().childId);
      let allowed = false;
      for (const childId of childIds) {
        const child = await this.childRepo.findById(kindergartenId, childId);
        if (child && child.toState().currentGroupId === story.groupId) {
          allowed = true;
          break;
        }
      }
      if (!allowed) {
        throw new ForbiddenActionError(
          'parent_not_in_story_group',
          'Parent is not a guardian of any child in this story group',
        );
      }
    }

    await this.storyRepo.incrementViews(kindergartenId, storyId);
  }

  private async runInTenantTx<T>(
    kindergartenId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const ambient = tenantStorage.getStore();
    if (ambient?.entityManager) {
      return fn();
    }
    return this.tx.run(async (em) => {
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

function classifyMediaType(mt: string): StoryMediaType {
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  throw new MediaTypeInvalidError(mt);
}

function extractKeyFromUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/^\/api\/v1\/media\/(.+)$/);
  return m ? m[1] : null;
}
