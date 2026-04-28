import { DomainError } from '@/shared-kernel/domain/errors';

export class InvalidChildStatusTransitionError extends DomainError {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(
      'invalid_child_status_transition',
      `cannot transition child status: ${from} -> ${to}`,
    );
  }
}
