import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — caller tried to create a tariff_assignment whose
 * `valid_from..valid_until` window overlaps with an existing open assignment
 * for the same child. Only one active assignment per child is permitted at
 * any moment in time.
 */
export class TariffAssignmentOverlapError extends ConflictError {
  public readonly code = 'tariff_assignment_overlap' as const;

  constructor(childId: string) {
    super(
      'tariff_assignment_overlap',
      `tariff assignment overlap for child: ${childId}`,
    );
  }
}
