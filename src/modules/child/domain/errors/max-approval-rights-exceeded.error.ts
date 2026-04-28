import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * Per-child cap: at most 2 guardians may hold has_approval_rights=true.
 * Mapped to HTTP 409.
 */
export class MaxApprovalRightsExceededError extends DomainError {
  constructor(public readonly childId: string) {
    super(
      'max_approval_rights_exceeded',
      `child=${childId} already has 2 approvers`,
    );
  }
}
