import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { KG_DEFAULT_TIMEZONE } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { tenantStorage } from '@/database/tenant-storage';
import { ContentRepository } from '../content.repository';
import {
  ContentPost,
  LocalisedText,
} from '../domain/entities/content-post.entity';

export const CONTENT_PUBLISH_QUEUE = 'content-publish';
export const CONTENT_PUBLISH_RECURRING_JOB = 'content-publish-recurring';
export const CONTENT_PUBLISH_MANUAL_JOB = 'content-publish-manual';
export const CONTENT_PUBLISH_CRON_EXPRESSION = '*/5 * * * *';
export const CONTENT_PUBLISH_CRON_TIMEZONE = KG_DEFAULT_TIMEZONE;
export const CONTENT_PUBLISH_SCHEDULER_ID = 'content-publish-cron';

const BATCH_SIZE = 100;

export interface ContentPublishJobData {
  /**
   * Optional ISO timestamp the operator wants to anchor the publish run
   * against — used by the manual trigger and integration tests. The
   * recurring tick leaves it empty and the processor falls through to
   * `clock.now()`.
   */
  now?: string | Date;
}

export interface ContentPublishSummary {
  kindergartensProcessed: number;
  publishedCount: number;
  skippedCount: number;
  errors: number;
  now: string;
}

/**
 * ContentPublishProcessor — flips `scheduled → published` for every post
 * whose `scheduled_for <= now`. Runs every 5 minutes Asia/Almaty.
 *
 * Per-kg flow (mirrors `DiscountExpireProcessor`):
 *   1. List active kgs under `bypass_rls=true`.
 *   2. Per kg, open its own TX with `app.kindergarten_id`, publish via
 *      `tenantStorage.run`.
 *   3. Inside the per-kg TX, list scheduled-due posts up to BATCH_SIZE,
 *      conditionally flip status, emit `content.<type>_published`.
 *
 * The conditional UPDATE WHERE status='scheduled' RETURNING * pattern
 * makes this race-safe against concurrent admin `publish` calls — only
 * one of the two flips will succeed; the other receives null and skips.
 */
@Processor(CONTENT_PUBLISH_QUEUE)
export class ContentPublishProcessor extends WorkerHost {
  private readonly logger = new Logger(ContentPublishProcessor.name);

  constructor(
    private readonly contentRepo: ContentRepository,
    private readonly notificationPort: NotificationPort,
    private readonly dataSource: DataSource,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(
    job: Job<ContentPublishJobData>,
  ): Promise<ContentPublishSummary> {
    if (
      job.name !== CONTENT_PUBLISH_RECURRING_JOB &&
      job.name !== CONTENT_PUBLISH_MANUAL_JOB
    ) {
      return {
        kindergartensProcessed: 0,
        publishedCount: 0,
        skippedCount: 0,
        errors: 0,
        now: '',
      };
    }
    return this.runOnce(this.computeNow(job.data?.now));
  }

  /** Manual trigger (also called by the integration spec). */
  async runOnce(now: Date): Promise<ContentPublishSummary> {
    const nowIso = now.toISOString();
    this.logger.log(`content-publish tick start: now=${nowIso}`);

    const kgIds = await this.listAllKindergartens();

    let publishedCount = 0;
    let skippedCount = 0;
    let errors = 0;
    for (const kgId of kgIds) {
      try {
        const result = await this.runForKindergarten(kgId, now);
        publishedCount += result.publishedCount;
        skippedCount += result.skippedCount;
      } catch (err) {
        errors += 1;
        const stack = err instanceof Error ? err.stack : String(err);
        this.logger.error(
          `content-publish: kg=${kgId} now=${nowIso} failed`,
          stack,
        );
      }
    }
    const summary: ContentPublishSummary = {
      kindergartensProcessed: kgIds.length,
      publishedCount,
      skippedCount,
      errors,
      now: nowIso,
    };
    this.logger.log(
      `content-publish tick summary: kgs=${summary.kindergartensProcessed} published=${summary.publishedCount} skipped=${summary.skippedCount} errors=${summary.errors}`,
    );
    return summary;
  }

  async runForKindergarten(
    kgId: string,
    now: Date,
  ): Promise<{ publishedCount: number; skippedCount: number }> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run(
        { kgId, bypass: false, entityManager: em },
        async () => {
          const scheduled = await this.contentRepo.listScheduledDue(
            kgId,
            now,
            BATCH_SIZE,
          );
          let published = 0;
          let skipped = 0;
          for (const post of scheduled) {
            const updated = await this.contentRepo.transitionStatus(
              kgId,
              post.id,
              'scheduled',
              'published',
              { publishedAt: now, updatedAt: now },
            );
            if (!updated) {
              skipped += 1;
              continue;
            }
            await this.emitPublishedEvent(updated, now);
            published += 1;
          }
          return { publishedCount: published, skippedCount: skipped };
        },
      );
    });
  }

  private async emitPublishedEvent(
    post: ContentPost,
    now: Date,
  ): Promise<void> {
    if (post.contentType === 'news') {
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
    if (post.contentType === 'qundylyq') {
      await this.notificationPort.notifyContentQundylyqNew({
        kindergartenId: post.kindergartenId,
        contentPostId: post.id,
        titleI18n: post.titleI18n,
        metadata: post.metadata,
        publishedAt: post.publishedAt ?? now,
      });
      return;
    }
    if (post.contentType === 'birthday') {
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
        targetChildId: post.targetChildId ?? '',
        childFullName: fullName,
        age,
        publishedAt: post.publishedAt ?? now,
      });
    }
  }

  private async listAllKindergartens(): Promise<string[]> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.bypass_rls', 'true', true)`);
      const rows = (await em.query(
        `SELECT id FROM kindergartens WHERE archived_at IS NULL ORDER BY id`,
      )) as Array<{ id: string }>;
      return rows.map((r) => r.id);
    });
  }

  private computeNow(jobData?: string | Date): Date {
    if (jobData !== undefined && jobData !== null) {
      const parsed = jobData instanceof Date ? jobData : new Date(jobData);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(
          `content-publish: invalid now payload: ${String(jobData)}`,
        );
      }
      return parsed;
    }
    return this.clock.now();
  }
}

function pickName(i18n: LocalisedText | null): string {
  if (!i18n) return '';
  return i18n.ru ?? i18n.kz ?? i18n.kk ?? i18n.en ?? '';
}

@Injectable()
export class ContentPublishScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(ContentPublishScheduler.name);

  constructor(
    @Optional()
    @InjectQueue(CONTENT_PUBLISH_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const flag = (process.env.CONTENT_PUBLISH_CRON ?? 'enabled').toLowerCase();
    if (flag === 'disabled') {
      this.logger.log(
        'content-publish scheduler skipped (CONTENT_PUBLISH_CRON=disabled)',
      );
      return;
    }
    if (!this.queue) {
      this.logger.warn(
        'content-publish scheduler skipped — BullMQ queue not provided',
      );
      return;
    }
    try {
      await this.queue.upsertJobScheduler(
        CONTENT_PUBLISH_SCHEDULER_ID,
        {
          pattern: CONTENT_PUBLISH_CRON_EXPRESSION,
          tz: CONTENT_PUBLISH_CRON_TIMEZONE,
        },
        {
          name: CONTENT_PUBLISH_RECURRING_JOB,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          },
        },
      );
      this.logger.log(
        `content-publish scheduler upserted (pattern=${CONTENT_PUBLISH_CRON_EXPRESSION} tz=${CONTENT_PUBLISH_CRON_TIMEZONE})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `content-publish scheduler upsert failed: ${msg} — continuing without recurring job`,
      );
    }
  }
}
