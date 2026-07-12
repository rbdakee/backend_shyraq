import { Logger } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import {
  BCC_RECONCILIATION_JOB,
  BCC_RECONCILIATION_QUEUE,
  BccReconciliationJobData,
} from './bcc-reconciliation.constants';
import { BccReconciliationService } from './bcc-reconciliation.service';

@Processor(BCC_RECONCILIATION_QUEUE)
export class BccReconciliationProcessor extends WorkerHost {
  private readonly logger = new Logger(BccReconciliationProcessor.name);

  constructor(
    private readonly reconciliation: BccReconciliationService,
    @InjectQueue(BCC_RECONCILIATION_QUEUE)
    private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job<BccReconciliationJobData>): Promise<{
    paymentId: string;
    outcome: string;
    nextAt: string | null;
  }> {
    if (job.name !== BCC_RECONCILIATION_JOB) {
      return { paymentId: '', outcome: 'ignored', nextAt: null };
    }
    const result = await this.reconciliation.reconcileOnce(
      job.data.kindergartenId,
      job.data.paymentId,
    );
    if (result.outcome === 'reschedule' && result.nextAt) {
      const tick = job.data.tick + 1;
      await this.queue.add(
        BCC_RECONCILIATION_JOB,
        { ...job.data, tick },
        {
          jobId: `bcc-reconcile-${job.data.paymentId}-${tick}`,
          attempts: 1,
          delay: Math.max(0, result.nextAt.getTime() - Date.now()),
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 100 },
        },
      );
    }
    this.logger.log(
      `bcc-reconciliation tick payment=${job.data.paymentId} outcome=${result.outcome}`,
    );
    return {
      paymentId: job.data.paymentId,
      outcome: result.outcome,
      nextAt: result.nextAt?.toISOString() ?? null,
    };
  }
}
