import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — admin tried to retry a `lifecycle` queue job that is not in the
 * `failed` state (e.g. already moved to `wait` by a prior retry, or still
 * `active` when the operator clicks twice). Only failed jobs can be safely
 * re-enqueued via `POST /admin/lifecycle/failed-jobs/:id/retry` (B22a T10).
 */
export class LifecycleJobNotInFailedStateError extends ConflictError {
  constructor(jobId: string) {
    super('lifecycle_job_not_in_failed_state', `lifecycle_job ${jobId}`);
  }
}
