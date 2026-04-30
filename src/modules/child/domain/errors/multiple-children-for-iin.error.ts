import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * Cross-tenant IIN lookup returned more than one child. The same IIN is
 * registered in multiple kindergartens (a transferred child is a typical
 * cause). The frontend cannot deterministically pick a target kindergarten —
 * the user must disambiguate (or contact support). Mapped to HTTP 409.
 *
 * `kindergartenIds` exposes the candidate tenants so DomainErrorFilter can
 * include them in the response `details` payload.
 */
export class MultipleChildrenForIinError extends ConflictError {
  constructor(
    public readonly iin: string,
    public readonly kindergartenIds: string[],
  ) {
    super(
      'multiple_children_for_iin',
      `iin=${iin} matches ${kindergartenIds.length} children across kindergartens`,
    );
  }

  get details(): Record<string, unknown> {
    return { iin: this.iin, kindergartenIds: this.kindergartenIds };
  }
}
