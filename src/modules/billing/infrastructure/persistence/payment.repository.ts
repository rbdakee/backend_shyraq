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

  abstract markProcessingConditional(
    kindergartenId: string,
    id: string,
    now: Date,
  ): Promise<Payment | null>;

  abstract markRefundedConditional(
    kindergartenId: string,
    id: string,
    refundId: string,
    now: Date,
  ): Promise<Payment | null>;

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
}
