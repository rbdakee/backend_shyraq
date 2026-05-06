import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — `payments.idempotency_key` UNIQUE constraint violation. The caller
 * replayed an `initiate` request whose key already corresponds to a payment
 * with different parameters. Spec-compliant idempotent retries reuse the
 * existing payment row instead of throwing.
 */
export class PaymentIdempotencyConflictError extends ConflictError {
  public readonly code = 'payment_idempotency_conflict' as const;

  constructor(idempotencyKey: string) {
    super(
      'payment_idempotency_conflict',
      `payment idempotency conflict: ${idempotencyKey}`,
    );
  }
}
