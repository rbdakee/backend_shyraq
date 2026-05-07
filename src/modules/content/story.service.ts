import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
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
    private readonly dataSource: DataSource,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async create(
    kindergartenId: string,
    groupId: string,
    createdBy: string,
    media: StoryCreateInput,
  ): Promise<GroupStory> {
    const group = await this.groupRepo.findById(kindergartenId, groupId);
    if (!group) throw new GroupNotFoundError(groupId);

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

  async incrementViews(kindergartenId: string, storyId: string): Promise<void> {
    const story = await this.storyRepo.findById(kindergartenId, storyId);
    if (!story) throw new GroupStoryNotFoundError(storyId);
    const now = this.clock.now();
    story.assertNotExpired(now);
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

function classifyMediaType(mt: string): StoryMediaType {
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  throw new MediaTypeInvalidError(mt);
}

function extractKeyFromUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/^\/static\/(.+)$/);
  return m ? m[1] : null;
}
