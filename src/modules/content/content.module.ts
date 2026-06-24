import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import { fileStorageProvider } from '@/shared-kernel/storage/file-storage.provider';
import { AdminContentController } from './admin-content.controller';
import { MediaController } from './media.controller';
import { ContentRepository } from './content.repository';
import { ContentService } from './content.service';
import { ContentFeedService } from './content-feed.service';
import { GroupStoryRepository } from './group-story.repository';
import { ParentContentController } from './parent-content.controller';
import { SaasContentController } from './saas-content.controller';
import { StaffMediaController } from './staff-media.controller';
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
    StaffMediaController,
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
