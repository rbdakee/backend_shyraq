import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when a list query has `from > to`.
 */
export class InvalidDateRangeError extends DomainError {
  public readonly code = 'invalid_date_range' as const;

  constructor(from: string, to: string) {
    super('invalid_date_range', `from (${from}) must not be after to (${to})`);
  }
}
