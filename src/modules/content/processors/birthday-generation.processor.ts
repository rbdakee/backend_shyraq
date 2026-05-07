import {
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
import { BirthdayGeneratorService } from '../birthday-generator.service';

export const BIRTHDAY_GENERATION_QUEUE = 'birthday-generation';
export const BIRTHDAY_GENERATION_RECURRING_JOB =
  'birthday-generation-recurring';
export const BIRTHDAY_GENERATION_MANUAL_JOB = 'birthday-generation-manual';
export const BIRTHDAY_GENERATION_CRON_EXPRESSION = '0 7 * * *';
export const BIRTHDAY_GENERATION_CRON_TIMEZONE = KG_DEFAULT_TIMEZONE;
export const BIRTHDAY_GENERATION_SCHEDULER_ID = 'birthday-generation-cron';

export interface BirthdayGenerationJobData {
  /** Optional ISO timestamp to anchor the run (manual/test mode). */
  now?: string | Date;
}

export interface BirthdayGenerationSummary {
  kindergartensProcessed: number;
  generatedCount: number;
  skippedCount: number;
  errors: number;
  now: string;
}

/**
 * BirthdayGenerationProcessor — daily at 07:00 Asia/Almaty. Iterates
 * every active kg and calls `BirthdayGeneratorService.runDaily`. Per-kg
 * failures are caught + counted; the loop never aborts so a misconfigured
 * kg can't block the rest of the batch.
 *
 * Idempotency: the service checks
 * `existsBirthdayForChildOnDate(kg, child, today)` before creating a
 * post — re-running the cron for the same calendar date is safe.
 */
@Processor(BIRTHDAY_GENERATION_QUEUE)
export class BirthdayGenerationProcessor extends WorkerHost {
  private readonly logger = new Logger(BirthdayGenerationProcessor.name);

  constructor(
    private readonly birthdayGenerator: BirthdayGeneratorService,
    private readonly dataSource: DataSource,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async process(
    job: Job<BirthdayGenerationJobData>,
  ): Promise<BirthdayGenerationSummary> {
    if (
      job.name !== BIRTHDAY_GENERATION_RECURRING_JOB &&
      job.name !== BIRTHDAY_GENERATION_MANUAL_JOB
    ) {
      return {
        kindergartensProcessed: 0,
        generatedCount: 0,
        skippedCount: 0,
        errors: 0,
        now: '',
      };
    }
    return this.runOnce(this.computeNow(job.data?.now));
  }

  async runOnce(now: Date): Promise<BirthdayGenerationSummary> {
    const nowIso = now.toISOString();
    this.logger.log(`birthday-generation tick start: now=${nowIso}`);

    const kgIds = await this.listAllKindergartens();

    let generatedCount = 0;
    let skippedCount = 0;
    let errors = 0;
    for (const kgId of kgIds) {
      try {
        const result = await this.runForKindergarten(kgId, now);
        generatedCount += result.generatedCount;
        skippedCount += result.skippedCount;
      } catch (err) {
        errors += 1;
        const stack = err instanceof Error ? err.stack : String(err);
        this.logger.error(
          `birthday-generation: kg=${kgId} now=${nowIso} failed`,
          stack,
        );
      }
    }
    const summary: BirthdayGenerationSummary = {
      kindergartensProcessed: kgIds.length,
      generatedCount,
      skippedCount,
      errors,
      now: nowIso,
    };
    this.logger.log(
      `birthday-generation tick summary: kgs=${summary.kindergartensProcessed} generated=${summary.generatedCount} skipped=${summary.skippedCount} errors=${summary.errors}`,
    );
    return summary;
  }

  async runForKindergarten(
    kgId: string,
    now: Date,
  ): Promise<{ generatedCount: number; skippedCount: number }> {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run({ kgId, bypass: false, entityManager: em }, () =>
        this.birthdayGenerator.runDaily(kgId, now),
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
          `birthday-generation: invalid now payload: ${String(jobData)}`,
        );
      }
      return parsed;
    }
    return this.clock.now();
  }
}

@Injectable()
export class BirthdayGenerationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BirthdayGenerationScheduler.name);

  constructor(
    @Optional()
    @InjectQueue(BIRTHDAY_GENERATION_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const flag = (
      process.env.BIRTHDAY_GENERATION_CRON ?? 'enabled'
    ).toLowerCase();
    if (flag === 'disabled') {
      this.logger.log(
        'birthday-generation scheduler skipped (BIRTHDAY_GENERATION_CRON=disabled)',
      );
      return;
    }
    if (!this.queue) {
      this.logger.warn(
        'birthday-generation scheduler skipped — BullMQ queue not provided',
      );
      return;
    }
    try {
      await this.queue.upsertJobScheduler(
        BIRTHDAY_GENERATION_SCHEDULER_ID,
        {
          pattern: BIRTHDAY_GENERATION_CRON_EXPRESSION,
          tz: BIRTHDAY_GENERATION_CRON_TIMEZONE,
        },
        {
          name: BIRTHDAY_GENERATION_RECURRING_JOB,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          },
        },
      );
      this.logger.log(
        `birthday-generation scheduler upserted (pattern=${BIRTHDAY_GENERATION_CRON_EXPRESSION} tz=${BIRTHDAY_GENERATION_CRON_TIMEZONE})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `birthday-generation scheduler upsert failed: ${msg} — continuing without recurring job`,
      );
    }
  }
}
