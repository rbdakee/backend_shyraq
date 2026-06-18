import { Module, Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import { LocalFileStorageAdapter } from '@/shared-kernel/storage/adapters/local-file-storage.adapter';
import {
  S3FileStorageAdapter,
  S3FileStorageOptions,
} from '@/shared-kernel/storage/adapters/s3-file-storage.adapter';
import { AdminContentController } from './admin-content.controller';
import { MediaController } from './media.controller';
import { ContentRepository } from './content.repository';
import { ContentService } from './content.service';
import { ContentFeedService } from './content-feed.service';
import { GroupStoryRepository } from './group-story.repository';
import { ParentContentController } from './parent-content.controller';
import { SaasContentController } from './saas-content.controller';
import { StaffStoriesController } from './staff-stories.controller';
import { StoryService } from './story.service';
import { BirthdayGeneratorService } from './birthday-generator.service';
import { ContentPostRelationalEntity } from './infrastructure/persistence/relational/entities/content-post.typeorm.entity';
import { GroupStoryRelationalEntity } from './infrastructure/persistence/relational/entities/group-story.typeorm.entity';
import { ContentPostRelationalRepository } from './infrastructure/persistence/relational/repositories/content-post.relational-repository';
import { GroupStoryRelationalRepository } from './infrastructure/persistence/relational/repositories/group-story.relational-repository';
import {
  BIRTHDAY_GENERATION_QUEUE,
  BirthdayGenerationProcessor,
  BirthdayGenerationScheduler,
} from './processors/birthday-generation.processor';
import {
  CONTENT_PUBLISH_QUEUE,
  ContentPublishProcessor,
  ContentPublishScheduler,
} from './processors/content-publish.processor';
import {
  STORY_CLEANUP_QUEUE,
  StoryCleanupProcessor,
  StoryCleanupScheduler,
} from './processors/story-cleanup.processor';

/**
 * Reads + validates the S3-compatible adapter config from the environment.
 * Fails loudly at bootstrap (rather than at first upload) if a required
 * credential is missing, matching the FCM/Kaspi adapter convention.
 *
 * Environments are isolated by BUCKET (not key-prefix): set
 * `FILE_STORAGE_BUCKET` per env — `balam-media` (prod), `balam-media-dev`
 * (dev / staging / other).
 *
 * ps.kz Object Storage (Universal tariff):
 *   FILE_STORAGE_ENDPOINT=https://object.pscloud.io   (virtual-hosted style)
 *   FILE_STORAGE_REGION=us-east-1                       (placeholder — ignored)
 *   FILE_STORAGE_FORCE_PATH_STYLE unset/false
 */
function readS3StorageOptions(): S3FileStorageOptions {
  const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value.trim() === '') {
      throw new Error(
        `FILE_STORAGE_PROVIDER=s3 requires ${name} to be set (see env-example-relational).`,
      );
    }
    return value;
  };
  const forcePathStyleRaw = (
    process.env.FILE_STORAGE_FORCE_PATH_STYLE ?? ''
  ).toLowerCase();
  return {
    bucket: required('FILE_STORAGE_BUCKET'),
    region: process.env.FILE_STORAGE_REGION || 'us-east-1',
    accessKeyId: required('FILE_STORAGE_ACCESS_KEY'),
    secretAccessKey: required('FILE_STORAGE_SECRET_KEY'),
    endpoint: process.env.FILE_STORAGE_ENDPOINT || undefined,
    forcePathStyle: forcePathStyleRaw === 'true',
    urlPrefix: process.env.FILE_STORAGE_URL_PREFIX || undefined,
  };
}

/**
 * Picks the file-storage adapter based on `process.env.FILE_STORAGE_PROVIDER`.
 * Defaults to `local` (Phase A). `s3` / `yandex` bind the S3-compatible
 * adapter (B17 Phase B) — both share the same code path, differing only by
 * the `FILE_STORAGE_ENDPOINT` / `FILE_STORAGE_FORCE_PATH_STYLE` config.
 *
 * `FILE_STORAGE_LOCAL_DIR` (default `uploads`) is the on-disk root for
 * local storage.
 */
function fileStorageProvider(): Provider {
  return {
    provide: FileStoragePort,
    useFactory: () => {
      const provider = (
        process.env.FILE_STORAGE_PROVIDER ?? 'local'
      ).toLowerCase();
      if (provider === 'local') {
        return new LocalFileStorageAdapter({
          uploadsDir: process.env.FILE_STORAGE_LOCAL_DIR ?? 'uploads',
        });
      }
      if (provider === 's3' || provider === 'yandex') {
        return new S3FileStorageAdapter(readS3StorageOptions());
      }
      throw new Error(
        `File storage provider '${provider}' not implemented; configure FILE_STORAGE_PROVIDER=local|s3|yandex`,
      );
    },
  };
}

/**
 * ContentModule (B17 §9). T3 wires services + repositories + ports +
 * processors. T4 will add controllers + DTOs + register the module in
 * `app.module.ts` with `ServeStaticModule` for `/static/*`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ContentPostRelationalEntity,
      GroupStoryRelationalEntity,
    ]),
    BullModule.registerQueue({ name: CONTENT_PUBLISH_QUEUE }),
    BullModule.registerQueue({ name: BIRTHDAY_GENERATION_QUEUE }),
    BullModule.registerQueue({ name: STORY_CLEANUP_QUEUE }),
    ChildModule,
    GroupModule,
  ],
  controllers: [
    AdminContentController,
    StaffStoriesController,
    ParentContentController,
    SaasContentController,
    MediaController,
  ],
  providers: [
    fileStorageProvider(),
    {
      provide: ContentRepository,
      useClass: ContentPostRelationalRepository,
    },
    {
      provide: GroupStoryRepository,
      useClass: GroupStoryRelationalRepository,
    },
    ContentService,
    StoryService,
    BirthdayGeneratorService,
    ContentFeedService,
    ContentPublishProcessor,
    ContentPublishScheduler,
    BirthdayGenerationProcessor,
    BirthdayGenerationScheduler,
    StoryCleanupProcessor,
    StoryCleanupScheduler,
  ],
  exports: [
    FileStoragePort,
    ContentRepository,
    GroupStoryRepository,
    ContentService,
    StoryService,
    BirthdayGeneratorService,
    ContentFeedService,
    BullModule,
  ],
})
export class ContentModule {}
