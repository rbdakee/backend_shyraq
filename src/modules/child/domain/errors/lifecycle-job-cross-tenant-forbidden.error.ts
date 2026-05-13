import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — per-kg admin tried to inspect or retry a BullMQ `lifecycle` queue
 * job whose `payload.kindergartenId` does not match their own tenant.
 * BullMQ has no native tenant filter, so the service-layer payload check
 * is the authoritative guard for cross-kg admin isolation (B22a T10).
 */
export class LifecycleJobCrossTenantForbiddenError extends ForbiddenActionError {
  constructor(jobId: string) {
    super('forbidden', `lifecycle_job ${jobId}`);
  }
}
