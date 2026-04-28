import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when a write target a staff_members row whose archived_at is set.
 * Maps to HTTP 409 Conflict — admin must restore before further changes.
 */
export class StaffArchivedError extends DomainError {
  constructor(id: string) {
    super('staff_archived', `staff member ${id} is archived`);
  }
}
