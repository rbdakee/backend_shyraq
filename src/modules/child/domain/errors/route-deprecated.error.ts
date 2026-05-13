import { GoneError } from '@/shared-kernel/domain/errors';

/**
 * 410 Gone — a once-supported route has been removed but the path still
 * lives in the router so old clients receive a documented signal (rather
 * than the indistinguishable router-level 404 they'd hit after full
 * removal). The `details.successor` field advertises the replacement
 * endpoint so client log-ingest can auto-redirect or alert.
 *
 * B22a: `POST /api/v1/children/:id/restore` -> see /reactivate. Full
 * controller-method removal is scheduled for B22b; until then this shim
 * keeps the surface honest.
 */
export class RouteDeprecatedError extends GoneError {
  public readonly code = 'endpoint_gone' as const;
  public readonly details: { successor: string };

  constructor(successor: string, message?: string) {
    super('endpoint_gone', message ?? `endpoint replaced by ${successor}`);
    this.details = { successor };
  }
}
