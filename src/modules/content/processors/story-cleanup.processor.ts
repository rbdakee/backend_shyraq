import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { KG_DEFAULT_TIMEZONE } from '@/shared-kernel/domain/value-objects/day-of-week.vo';
import { tenantStorage } from '@/database/tenant-storage';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import { GroupStoryRepository } from '../group-story.repository';

export const STORY_CLEANUP_QUEUE = 'story-cleanup';
export const STORY_CLEANUP_RECURRING_JOB = 'story-cleanup-recurring';
export const STORY_CLEANUP_MANUAL_JOB = 'story-cleanup-manual';
export const STORY_CLEANUP_CRON_EXPRESSION = '0 * * * *';
export const STORY_CLEANUP_CRON_TIMEZONE = KG_DEFAULT_TIMEZONE;
export const STORY_CLEANUP_SCHEDULER_ID = 'story-cleanup-cron';

const BATCH_SIZE = 200;

export interface StoryCleanupJobData {
  now?: string | Date;
}

export interface StoryCleanupSummary {
  kindergartensProcessed: number;
  deletedCount: number;
  errors: number;
  now: string;
}

/**
 * StoryCleanupProcessor — runs hourly. Iterates every active kg and
 * sweeps `group_stories` rows whose `expires_at <= now`. For each row:
 *   1. Best-effort `FileStoragePort.delete(extractKey(media_url))`. A
 *      failure logs a warning and DOES NOT block the SQL DELETE — the
 *      file is harmless garbage on local disk / S3 lifecycle rule will
 *      sweep eventually.
 *   2. `repo.deleteById` removes the row.
 *
 * Relies on `idx_group_stories_kg_expires_at` for fast batched
 * scanning. Per-kg batch is BATCH_SIZE rows; the cron runs every hour
 * so backlogged storage takes at most a few hours to drain even on
 * worst-case bursts.
 */
@Processor(STORY_CLEANUP_QUEUE)
export class StoryCleanupProcessor extends WorkerHost {
  private readonly logger = new Logger(StoryCleanupProcessor.name);

  constructor(
    private readonly storyRepo: GroupStoryRepository,
    private readonly fileStorage: FileStoragePort,
    private readonly dataSource: DataSource,
    // SP1 (FINDINGS): explicit `@Inject(ClockPort)` so the worker process
    // resolves the abstract port via reflect-metadata (BullMQ workers boot
    // under a different DI graph and can otherwise see `undefined` for
    // abstract-class tokens).
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(job: Job<StoryCleanupJobData>): Promise<StoryCleanupSummary> {
    if (
      job.name !== STORY_CLEANUP_RECURRING_JOB &&
      job.name !== STORY_CLEANUP_MANUAL_JOB
    ) {
      return {
        kindergartensProcessed: 0,
        deletedCount: 0,
        errors: 0,
        now: '',
      };
    }
    return this.runOnce(this.computeNow(job.data?.now));
  }

  async runOnce(now: Date): Promise<StoryCleanupSummary> {
    const nowIso = now.toISOString();
    this.logger.log(`story-cleanup tick start: now=${nowIso}`);

    const kgIds = await this.listAllKindergartens();

    let deletedCount = 0;
    let errors = 0;
    for (const kgId of kgIds) {
      try {
        const result = await this.runForKindergarten(kgId, now);
        deletedCount += result.deletedCount;
      } catch (err) {
        errors += 1;
        const stack = err instanceof Error ? err.stack : String(err);
        this.logger.error(
          `story-cleanup: kg=${kgId} now=${nowIso} failed`,
          stack,
        );
      }
    }
    const summary: StoryCleanupSummary = {
      kindergartensProcessed: kgIds.length,
      deletedCount,
      errors,
      now: nowIso,
    };
    this.logger.log(
      `story-cleanup tick summary: kgs=${summary.kindergartensProcessed} deleted=${summary.deletedCount} errors=${summary.errors}`,
    );
    return summary;
  }

  async runForKindergarten(
    kgId: string,
    now: Date,
  ): Promise<{ deletedCount: number }> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run(
        { kgId, bypass: false, entityManager: em },
        async () => {
          const expired = await this.storyRepo.listExpired(
            kgId,
            now,
            BATCH_SIZE,
          );
          let deleted = 0;
          for (const story of expired) {
            const key = extractKeyFromUrl(story.mediaUrl);
            if (key) {
              try {
                await this.fileStorage.delete(key);
              } catch (err) {
                this.logger.warn(
                  `story-cleanup_storage_delete_failed key=${key}: ${(err as Error).message}`,
                );
              }
            }
            const wasDeleted = await this.storyRepo.deleteById(kgId, story.id);
            if (wasDeleted) deleted += 1;
          }
          return { deletedCount: deleted };
        },
      );
    });
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
          `story-cleanup: invalid now payload: ${String(jobData)}`,
        );
      }
      return parsed;
    }
    return this.clock.now();
  }
}

function extractKeyFromUrl(url: string): string | null {
  if (!url) return null;
  const m = url.match(/^\/api\/v1\/media\/(.+)$/);
  return m ? m[1] : null;
}

@Injectable()
export class StoryCleanupScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(StoryCleanupScheduler.name);

  constructor(
    @Optional()
    @InjectQueue(STORY_CLEANUP_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const flag = (process.env.STORY_CLEANUP_CRON ?? 'enabled').toLowerCase();
    if (flag === 'disabled') {
      this.logger.log(
        'story-cleanup scheduler skipped (STORY_CLEANUP_CRON=disabled)',
      );
      return;
    }
    if (!this.queue) {
      this.logger.warn(
        'story-cleanup scheduler skipped — BullMQ queue not provided',
      );
      return;
    }
    try {
      await this.queue.upsertJobScheduler(
        STORY_CLEANUP_SCHEDULER_ID,
        {
          pattern: STORY_CLEANUP_CRON_EXPRESSION,
          tz: STORY_CLEANUP_CRON_TIMEZONE,
        },
        {
          name: STORY_CLEANUP_RECURRING_JOB,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          },
        },
      );
      this.logger.log(
        `story-cleanup scheduler upserted (pattern=${STORY_CLEANUP_CRON_EXPRESSION} tz=${STORY_CLEANUP_CRON_TIMEZONE})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `story-cleanup scheduler upsert failed: ${msg} — continuing without recurring job`,
      );
    }
  }
}
