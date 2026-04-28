import { DomainError } from '@/shared-kernel/domain/errors';

export class InvalidGuardianStatusTransitionError extends DomainError {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(
      'invalid_guardian_status_transition',
      `cannot transition guardian status: ${from} -> ${to}`,
    );
  }
}
