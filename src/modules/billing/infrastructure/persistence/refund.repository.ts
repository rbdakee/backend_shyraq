import { EntityManager } from 'typeorm';
import { Refund, RefundStatus } from '../../domain/entities/refund.entity';

export interface ListRefundsFilter {
  status?: RefundStatus;
  paymentId?: string;
  /** ISO `YYYY-MM-DD`. Filters `created_at >= fromDate`. */
  fromDate?: Date;
  /** ISO `YYYY-MM-DD`. Filters `created_at <= toDate`. */
  toDate?: Date;
}

/**
 * Persistence port for the Refund aggregate (B13).
 *
 * T2 wired the domain entity + state machine; T5b adds the CRUD + state-flip
 * surface so `RefundService` can drive the
 *
 *   pending  ──approve──► approved
 *   pending  ──reject──►  rejected
 *   approved ──process──► processed
 *
 * transitions atomically. Each conditional method returns the updated
 * `Refund` on success or `null` when the row is in a different state — the
 * service maps `null` to a domain error (`RefundAlreadyProcessedError` /
 * `RefundNotFoundError`).
 *
 * Tenant-scoped: the relational impl participates in the ambient tenant TX
 * established by `TenantContextInterceptor`, so RLS filters rows
 * automatically.
 */
export abstract class RefundRepository {
  /**
   * Inserts a fresh `refunds` row. Caller is expected to construct the
   * domain entity in `pending` state (no transition required at create
   * time — `pending` is the initial state).
   */
  abstract create(refund: Refund, manager?: EntityManager): Promise<Refund>;

  abstract findById(kindergartenId: string, id: string): Promise<Refund | null>;

  abstract findByPaymentId(
    kindergartenId: string,
    paymentId: string,
  ): Promise<Refund[]>;

  abstract list(
    kindergartenId: string,
    filter?: ListRefundsFilter,
  ): Promise<Refund[]>;

  /**
   * Conditional UPDATE: `SET status='approved', processed_by=$processedBy,
   * updated_at=$now WHERE id=$id AND kindergarten_id=$kg AND status='pending'
   * RETURNING *`. Returns the hydrated domain on success, `null` on 0
   * rows (status race lost — refund was already past `pending`).
   */
  abstract markApprovedConditional(
    kindergartenId: string,
    id: string,
    processedBy: string,
    now: Date,
  ): Promise<Refund | null>;

  /**
   * Conditional UPDATE: flips `pending → rejected` and overwrites the
   * `reason` column with the rejection note (single-column design — see
   * `Refund.reject` docstring).
   */
  abstract markRejectedConditional(
    kindergartenId: string,
    id: string,
    reason: string,
    now: Date,
  ): Promise<Refund | null>;

  /**
   * Conditional UPDATE: flips `approved → processed`, persists
   * `provider_ref` (returned from `PaymentProviderPort.refund`).
   */
  abstract markProcessedConditional(
    kindergartenId: string,
    id: string,
    providerRef: string | null,
    now: Date,
  ): Promise<Refund | null>;

  /**
   * Acquires `pg_advisory_xact_lock(hashtext('billing:refund:'||refundId))`.
   * Released automatically on TX commit / rollback.
   *
   * Used by `RefundService.process` BEFORE the provider call to serialise
   * concurrent admin "process" clicks on the same refund. Without this two
   * concurrent processes both pass the initial `findById → 'approved'`
   * check and both call `paymentProvider.refund`, doubling the chargeback
   * at provider-side for vendors that don't honour our idempotency key.
   *
   * MUST be called inside an ambient TX — outside one the lock is
   * released at the implicit per-statement boundary (no-op).
   *
   * Sums by id (not kg + id) because the refund id is itself a UUID —
   * collisions across tenants are infinitesimal and the kg context is
   * already enforced by the surrounding RLS scope.
   */
  abstract acquireRefundProcessAdvisoryLock(
    kindergartenId: string,
    refundId: string,
  ): Promise<void>;

  /**
   * Sums `refunds.amount` for the given invoice across rows where
   * `status='processed'`. Used by `RefundService.process` to decide
   * whether to flip the invoice to `refunded` (full coverage) or leave
   * it in `paid`/`partial` with a reduced effective balance.
   */
  abstract getProcessedRefundsSumForInvoice(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<number>;

  // ── B21 T3 ProRataRefundProcessor helpers ─────────────────────────────
  //
  // Both methods carry default no-op implementations so older test fakes
  // (B13 .. B20) keep compiling. The relational impl overrides each.

  /**
   * Acquires `pg_advisory_xact_lock(hashtext('billing:pro-rata:'||kgId||':'||childId))`
   * to serialise concurrent ProRataRefundProcessor runs targeting the
   * same archived child. Released automatically on TX commit / rollback.
   *
   * MUST be called inside an ambient TX — outside one the lock is
   * released at the implicit per-statement boundary (no-op).
   */
  acquireProRataAdvisoryLock(
    _kindergartenId: string,
    _childId: string,
  ): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Returns refunds for the child that look like pro-rata-on-archive rows
   * created on or after `since`. Implementation: joins refunds → invoices
   * to filter by child_id (refund table has no child_id column), AND
   * `reason = 'pro_rata_archive'` to scope to the lifecycle-issued rows.
   * Used by the processor as the idempotency guard — a non-empty result
   * means a prior run already wrote the refund row and the current job
   * is a retry.
   */
  findPendingProRataForChildSinceArchive(
    _kindergartenId: string,
    _childId: string,
    _since: Date,
  ): Promise<Refund[]> {
    return Promise.resolve([]);
  }
}
