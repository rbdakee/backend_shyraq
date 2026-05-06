import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a refund id that is not visible under the
 * caller's tenant scope (or simply does not exist).
 */
export class RefundNotFoundError extends NotFoundError {
  public readonly code = 'refund_not_found' as const;

  constructor(refundId: string) {
    super('refund', refundId);
  }
}
