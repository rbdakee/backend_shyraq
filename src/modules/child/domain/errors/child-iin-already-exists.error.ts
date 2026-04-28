import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Conflict on (kindergarten_id, iin) — same IIN already attached to another
 * child in this kindergarten. Mapped to HTTP 409.
 */
export class ChildIinAlreadyExistsError extends DomainError {
  constructor(public readonly iin: string) {
    super(
      'child_iin_exists',
      `child with iin=${iin} already exists in this kindergarten`,
    );
  }
}
