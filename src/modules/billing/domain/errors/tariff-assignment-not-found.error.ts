import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a tariff_assignment id that is not visible under
 * the caller's tenant scope (or simply does not exist).
 */
export class TariffAssignmentNotFoundError extends NotFoundError {
  public readonly code = 'tariff_assignment_not_found' as const;

  constructor(assignmentId: string) {
    super('tariff_assignment', assignmentId);
  }
}
