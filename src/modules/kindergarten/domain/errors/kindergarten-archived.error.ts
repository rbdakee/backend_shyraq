import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when an operation requires an active kindergarten but the row is
 * already archived (archivedAt != null). Maps to HTTP 409 Conflict.
 */
export class KindergartenArchivedError extends DomainError {
  constructor(id: string) {
    super('kindergarten_archived', `kindergarten already archived: ${id}`);
  }
}
