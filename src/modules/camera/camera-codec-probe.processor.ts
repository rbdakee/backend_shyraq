import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  Optional,
} from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { AllConfigType } from '@/config/config.type';
import { tenantStorage } from '@/database/tenant-storage';
import { CameraService } from './camera.service';

export const CAMERA_CODEC_PROBE_QUEUE = 'camera-codec-probe';
export const CAMERA_CODEC_PROBE_RECURRING_JOB = 'camera-codec-probe-recurring';
export const CAMERA_CODEC_PROBE_MANUAL_JOB = 'camera-codec-probe-manual';
export const CAMERA_CODEC_PROBE_SCHEDULER_ID = 'camera-codec-probe-cron';
/** Every 30 minutes. A codec changes when an installer visits a site — hours
 *  of staleness are harmless, and each tick costs one RTSP dial per camera. */
export const CAMERA_CODEC_PROBE_CRON_EXPRESSION = '*/30 * * * *';

export interface CameraCodecProbeSummary {
  kindergartensProcessed: number;
  probed: number;
  updated: number;
  unavailable: number;
  errors: number;
}

/**
 * CameraCodecProbeProcessor — keeps `cameras.video_codec` honest.
 *
 * Without this job the H.265→H.264 switch would be a deploy: someone would
 * have to notice the camera changed and edit a row. With it, the kindergarten
 * flips the camera in its own web UI and within half an hour the backend
 * starts advertising the WebRTC variant for that camera on its own.
 *
 * Runs in the api process (CameraModule is not part of WorkerModule), which is
 * fine: the work is a handful of HTTP calls to the media gateway per tick.
 */
@Processor(CAMERA_CODEC_PROBE_QUEUE)
export class CameraCodecProbeProcessor extends WorkerHost {
  private readonly logger = new Logger(CameraCodecProbeProcessor.name);

  constructor(
    private readonly cameras: CameraService,
    private readonly dataSource: DataSource,
  ) {
    super();
  }

  async process(job: Job): Promise<CameraCodecProbeSummary> {
    if (
      job.name !== CAMERA_CODEC_PROBE_RECURRING_JOB &&
      job.name !== CAMERA_CODEC_PROBE_MANUAL_JOB
    ) {
      return {
        kindergartensProcessed: 0,
        probed: 0,
        updated: 0,
        unavailable: 0,
        errors: 0,
      };
    }
    return this.runOnce();
  }

  async runOnce(): Promise<CameraCodecProbeSummary> {
    const kgIds = await this.listAllKindergartens();
    const summary: CameraCodecProbeSummary = {
      kindergartensProcessed: kgIds.length,
      probed: 0,
      updated: 0,
      unavailable: 0,
      errors: 0,
    };

    for (const kgId of kgIds) {
      try {
        const result = await this.runForKindergarten(kgId);
        summary.probed += result.probed;
        summary.updated += result.updated;
        summary.unavailable += result.unavailable;
      } catch (err) {
        summary.errors += 1;
        const stack = err instanceof Error ? err.stack : String(err);
        this.logger.error(`camera-codec-probe: kg=${kgId} failed`, stack);
      }
    }

    if (summary.updated > 0 || summary.unavailable > 0) {
      this.logger.log(
        `camera-codec-probe tick: kgs=${summary.kindergartensProcessed} probed=${summary.probed} updated=${summary.updated} unavailable=${summary.unavailable} errors=${summary.errors}`,
      );
    }
    return summary;
  }

  private async runForKindergarten(kgId: string) {
    return this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      return tenantStorage.run({ kgId, bypass: false, entityManager: em }, () =>
        this.cameras.refreshCodecs(kgId),
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
}

@Injectable()
export class CameraCodecProbeScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(CameraCodecProbeScheduler.name);

  constructor(
    private readonly config: ConfigService<AllConfigType>,
    @Optional()
    @InjectQueue(CAMERA_CODEC_PROBE_QUEUE)
    private readonly queue?: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('cctv.codecProbeEnabled', { infer: true })) {
      this.logger.log(
        'camera-codec-probe scheduler skipped (CCTV_CODEC_PROBE_CRON=disabled)',
      );
      return;
    }
    if (!this.queue) {
      this.logger.warn(
        'camera-codec-probe scheduler skipped — BullMQ queue not provided',
      );
      return;
    }
    try {
      await this.queue.upsertJobScheduler(
        CAMERA_CODEC_PROBE_SCHEDULER_ID,
        { pattern: CAMERA_CODEC_PROBE_CRON_EXPRESSION },
        {
          name: CAMERA_CODEC_PROBE_RECURRING_JOB,
          opts: {
            attempts: 2,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: 20,
            removeOnFail: 50,
          },
        },
      );
      this.logger.log(
        `camera-codec-probe scheduler registered (${CAMERA_CODEC_PROBE_CRON_EXPRESSION})`,
      );
    } catch (err) {
      const stack = err instanceof Error ? err.stack : String(err);
      this.logger.error(
        'camera-codec-probe scheduler registration failed',
        stack,
      );
    }
  }
}
