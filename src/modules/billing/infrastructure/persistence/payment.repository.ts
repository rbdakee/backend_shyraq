/**
 * Persistence port for the Payment aggregate (B13).
 *
 * T3 declares only the advisory-lock method needed for the pay+webhook
 * race. Full CRUD + state-flip methods (`create`, `findByIdempotencyKey`,
 * `findByProviderTxnId`, conditional-UPDATE `markCompleted` / `markFailed`,
 * etc.) arrive in T5a alongside the TypeORM entity + mapper.
 *
 * Tenant-scoped for parent-side endpoints (`POST /parent/invoices/:id/pay`)
 * — the relational impl runs through the ambient tenant TX. Webhook
 * lookups (cross-tenant, by `provider_txn_id`) bypass RLS via a per-event
 * TX with `SET LOCAL app.bypass_rls='true'` (T5a).
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
}
