import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — admin tried to retry a BullMQ `lifecycle` queue job whose id does
 * not resolve to any known job (already auto-cleaned by `removeOnFail`
 * retention, or never existed). Surfaced via `GET /admin/lifecycle/failed-jobs`
 * + `POST /admin/lifecycle/failed-jobs/:id/retry` (B22a T10).
 */
export class LifecycleJobNotFoundError extends NotFoundError {
  public readonly code = 'lifecycle_job_not_found' as const;

  constructor(jobId: string) {
    super('lifecycle_job', jobId);
  }
}
