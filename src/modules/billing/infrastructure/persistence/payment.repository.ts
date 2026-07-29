import { EntityManager } from 'typeorm';
import {
  Payment,
  PaymentProvider,
  PaymentStatus,
} from '../../domain/entities/payment.entity';

export interface ListPaymentsFilter {
  provider?: PaymentProvider;
  status?: PaymentStatus;
  childId?: string;
  /** Restrict to payments targeting a single invoice (parent history view). */
  invoiceId?: string;
  /** When true, return only payments flagged `refund_required` (#5b). */
  refundRequired?: boolean;
  /** ISO `YYYY-MM-DD`. Filters `created_at >= fromDate`. */
  fromDate?: Date;
  /** ISO `YYYY-MM-DD`. Filters `created_at <= toDate`. */
  toDate?: Date;
}

/**
 * Persistence port for the Payment aggregate (B13).
 *
 * T3 declared only `acquirePaymentAdvisoryLock`. T5a expands the surface to
 * the full CRUD + state-machine helpers used by `PaymentService`. Each
 * conditional method returns the updated `Payment` on success or `null` if
 * the row is in a different state — the service maps `null` to a domain
 * error (or treats it as an idempotent replay, depending on the call site).
 *
 * Tenant-scoped: the relational impl participates in the ambient tenant TX
 * established by `TenantContextInterceptor`, so RLS filters rows
 * automatically. The exception is `findByProviderTxnIdCrossTenant` — webhook
 * handlers arrive without a kg context and must look up the payment by
 * `(provider, provider_txn_id)` before establishing the kg scope. That
 * method opens its own TX with `SET LOCAL app.bypass_rls='true'` so the
 * GUC does not leak back into the ambient TX (B10 T7-2 HIGH#2).
 */
export abstract class PaymentRepository {
  /**
   * Acquires `pg_advisory_xact_lock(hashtext('billing:payment:'||kgId||':'||invoiceId))`.
   * Released automatically when the surrounding TX commits or rolls back.
   *
   * Used by both `payment.service.initiate` (parent-pay) and
   * `payment.service.processWebhook` to serialise concurrent operations on
   * the same invoice. Without the lock a parent-pay TX and a webhook TX
   * can both read `invoice.status='pending'` and both transition it to
   * `paid` — producing two `payment` rows applied to one invoice and a
   * double-emit of the fiscal receipt.
   *
   * MUST be called inside an ambient TX — outside one the lock is
   * released at the implicit per-statement boundary, effectively a no-op.
   */
  abstract acquirePaymentAdvisoryLock(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<void>;

  /**
   * Inserts a new `payments` row. Throws `PaymentIdempotencyConflictError`
   * when the unique constraint on `idempotency_key` is violated (PG
   * `23505` + `uq_payments_idempotency_key`). Other PG errors propagate
   * unchanged.
   */
  abstract create(payment: Payment, manager?: EntityManager): Promise<Payment>;

  abstract findById(
    kindergartenId: string,
    id: string,
  ): Promise<Payment | null>;

  abstract findByIdempotencyKey(
    kindergartenId: string,
    idempotencyKey: string,
  ): Promise<Payment | null>;

  abstract findByInvoiceId(
    kindergartenId: string,
    invoiceId: string,
  ): Promise<Payment[]>;

  findByProviderTxnId(
    _kindergartenId: string,
    _provider: PaymentProvider,
    _providerTxnId: string,
  ): Promise<Payment | null> {
    return Promise.resolve(null);
  }

  abstract list(
    kindergartenId: string,
    filter?: ListPaymentsFilter,
  ): Promise<Payment[]>;

  /**
   * Cross-tenant lookup by `(provider, provider_txn_id)` — used by the
   * webhook handler before the kg context is known. The relational impl
   * MUST open a fresh `dataSource.transaction()` and `SET LOCAL
   * app.bypass_rls='true'` inside it, so the GUC does not leak into the
   * ambient TX (B10 T7-2 HIGH#2 pattern).
   */
  abstract findByProviderTxnIdCrossTenant(
    provider: PaymentProvider,
    providerTxnId: string,
  ): Promise<Payment | null>;

  /**
   * Cross-tenant lookup by `(kindergartenId, id)` — used by the K8 Kaspi
   * status poller, which runs outside any HTTP/RLS context. The relational
   * impl MUST open a fresh `dataSource.transaction()` and `SET LOCAL
   * app.bypass_rls='true'` inside it so the GUC does not leak into any ambient
   * TX (mirrors `findByProviderTxnIdCrossTenant`).
   */
  abstract findByIdCrossTenant(
    kindergartenId: string,
    id: string,
  ): Promise<Payment | null>;

  /**
   * Conditional UPDATE: `SET status='completed', provider_txn_id=$tx,
   * paid_at=$now, provider_payload=$payload, updated_at=$now WHERE id=$id
   * AND kindergarten_id=$kg AND status IN ('initiated','processing')
   * RETURNING *`. Returns the hydrated domain on success, `null` on 0
   * rows (status race lost — payment was already terminal).
   */
  abstract markCompletedConditional(
    kindergartenId: string,
    id: string,
    providerTxnId: string,
    paidAt: Date,
    providerPayload: Record<string, unknown> | null,
    now: Date,
  ): Promise<Payment | null>;

  abstract markFailedConditional(
    kindergartenId: string,
    id: string,
    failureReason: string,
    providerPayload: Record<string, unknown> | null,
    now: Date,
  ): Promise<Payment | null>;

  updateProviderPayload(
    _kindergartenId: string,
    _id: string,
    _providerPayload: Record<string, unknown>,
    _now: Date,
  ): Promise<Payment | null> {
    return Promise.resolve(null);
  }

  /**
   * Conditional transition `initiated → processing`. Optionally persists the
   * provider txn id (Kaspi QrOperationId) and merges `providerPayload` into the
   * existing `provider_payload` so the K8 poller / refund can correlate via
   * `provider_txn_id`. Both extra params are optional to keep older callers
   * (synchronous providers) working unchanged.
   */
  abstract markProcessingConditional(
    kindergartenId: string,
    id: string,
    now: Date,
    providerTxnId?: string | null,
    providerPayload?: Record<string, unknown> | null,
  ): Promise<Payment | null>;

  abstract markRefundedConditional(
    kindergartenId: string,
    id: string,
    refundId: string,
    now: Date,
  ): Promise<Payment | null>;

  /**
   * Flag a completed payment as a double payment needing a manual refund (#5b).
   * Unconditional UPDATE on the (already-settled) row: sets `refund_required`,
   * `refund_reason` and `duplicate_of_payment_id` (the first/kept payment).
   * Returns the hydrated row, or null if the id was not found in this kg.
   */
  abstract markRefundRequired(
    kindergartenId: string,
    id: string,
    reason: string,
    duplicateOfPaymentId: string,
    now: Date,
  ): Promise<Payment | null>;

  /**
   * Initializes the first BCC status check. The relational implementation
   * only updates a processing BCC row and never revives a terminal payment.
   */
  scheduleBccReconciliation(
    _kindergartenId: string,
    _id: string,
    _nextAt: Date,
    _now: Date,
  ): Promise<Payment | null> {
    return Promise.resolve(null);
  }

  /**
   * Atomically claims a due BCC status check from a worker without an HTTP
   * tenant context. `leaseUntil` prevents a duplicate BullMQ delivery from
   * issuing the same status request concurrently.
   */
  claimBccReconciliationCrossTenant(
    _kindergartenId: string,
    _id: string,
    _now: Date,
    _leaseUntil: Date,
  ): Promise<Payment | null> {
    return Promise.resolve(null);
  }

  rescheduleBccReconciliationCrossTenant(
    _kindergartenId: string,
    _id: string,
    _nextAt: Date,
    _now: Date,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }

  markBccManualReviewCrossTenant(
    _kindergartenId: string,
    _id: string,
    _now: Date,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }

  // ── B-DASH — Dashboard revenue aggregate ──────────────────────────────

  /**
   * GROSS completed-payment revenue for a half-open instant window:
   *
   *   COALESCE(SUM(amount),0)
   *   WHERE kindergarten_id=$1 AND status='completed'
   *         AND paid_at >= $fromIso AND paid_at < $toIsoExclusive
   *
   * Locked decision §0#3: gross (refunds NOT subtracted). Bounds are UTC
   * ISO instants derived from Asia/Almaty calendar month/year starts.
   * Called twice by DashboardService (MTD, YTD). Default stub so older
   * in-memory test fakes compile; the relational impl overrides.
   */
  sumCompletedBetween(
    _kindergartenId: string,
    _fromIso: string,
    _toIsoExclusive: string,
  ): Promise<number> {
    return Promise.resolve(0);
  }

  /**
   * Payments-overview provider breakdown (§2.2 — basis is PAYMENTS, the only
   * rows that carry `provider`): `status='completed'`, paid_at in the
   * half-open instant window [fromIso, toIsoExclusive), GROUP BY provider,
   * count + SUM(amount). The window bounds are UTC instants the service
   * derives from the Asia/Almaty calendar [from, to] day range. Ordered by
   * provider for a stable response.
   *
   * Default stub so older in-memory test fakes compile; the relational impl
   * overrides.
   */
  aggregateByProviderBetween(
    _kindergartenId: string,
    _fromIso: string,
    _toIsoExclusive: string,
  ): Promise<Array<{ provider: string; count: number; amount: number }>> {
    return Promise.resolve([]);
  }
}
