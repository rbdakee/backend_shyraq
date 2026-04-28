import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Some guardian operations (PATCH permissions, toggle approval rights, reset
 * permissions) require status=approved. Pending/rejected/revoked → 422.
 */
export class GuardianNotApprovedError extends DomainError {
  constructor(
    public readonly guardianId: string,
    public readonly currentStatus: string,
  ) {
    super(
      'guardian_not_approved',
      `guardian=${guardianId} must be in status=approved (current: ${currentStatus})`,
    );
  }
}
