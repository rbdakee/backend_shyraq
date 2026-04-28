import { DomainError } from '@/shared-kernel/domain/errors';

export class ProfileUniqueViolationError extends DomainError {
  constructor() {
    super('unique_violation');
  }
}
