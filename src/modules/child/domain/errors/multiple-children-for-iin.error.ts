import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * Cross-tenant IIN lookup returned more than one child. The same IIN is
 * registered in multiple kindergartens (a transferred child is a typical
 * cause). The frontend cannot deterministically pick a target kindergarten —
 * the user must contact their kindergarten admin for support.
 *
 * Mapped to HTTP 409. The error body intentionally does NOT expose the list
 * of kindergartens — that would let any authenticated caller probe IIN ↔
 * tenant membership across the whole platform. The IIN itself stays in
 * `details` so the client can echo back the input the user provided.
 */
export class MultipleChildrenForIinError extends ConflictError {
  constructor(public readonly iin: string) {
    super(
      'multiple_children_for_iin',
      `iin=${iin} matches more than one child across kindergartens`,
    );
  }

  get details(): Record<string, unknown> {
    return { iin: this.iin };
  }
}
