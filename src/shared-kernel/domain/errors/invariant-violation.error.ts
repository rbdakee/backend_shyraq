import { DomainError } from './domain.error';

export class InvariantViolationError extends DomainError {
  constructor(message: string) {
    super('invariant_violation', message);
  }
}
