import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Raised when a write targets a location whose archived_at is set. Maps to
 * HTTP 409 Conflict — caller must restore before further changes.
 */
export class LocationArchivedError extends DomainError {
  constructor(id: string) {
    super('location_archived', `location ${id} is archived`);
  }
}
