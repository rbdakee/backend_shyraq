import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * 400 — an operator tried to `process` a `kaspi_pay` refund without explicitly
 * acknowledging they verified the Kaspi refund/return history first.
 *
 * Why this gate exists (B24 / K9 — locked escalation decision):
 *   The reverse-engineered Kaspi API has NO idempotency key. `RefundService.
 *   process` sends `idempotencyKey: 'refund:<id>'`, which the Mock + Halyk
 *   adapters honour (a retry returns the same providerRefundId) but the Kaspi
 *   adapter IGNORES — its `refund()` simply POSTs `history-pos-return` with no
 *   idempotency. So a blind re-`process` after an *ambiguous network failure*
 *   could DOUBLE-REFUND at Kaspi.
 *
 *   There is already no auto-retry (on provider failure the refund stays
 *   `approved` and an operator must re-click `POST /admin/refunds/:id/process`).
 *   What this error enforces is that for `kaspi_pay` refunds the operator must
 *   EXPLICITLY pass `acknowledge_kaspi_history_checked=true` confirming they
 *   checked the Kaspi app's refund/return history before each process call.
 *
 *   The real idempotency fix — a local provider-call ledger — is out of B24
 *   scope (recorded as a follow-up in IMPLEMENTATION_PLAN.md §5).
 *
 * Extends `DomainError` directly with an explicit `DomainErrorFilter` branch →
 * HTTP 400 (matching the sibling `KaspiPhoneRequiredError` style and the
 * `payment_provider_mismatch` 400 of the K9 parent-pay guard).
 */
export class KaspiRefundHistoryAckRequiredError extends DomainError {
  constructor() {
    super(
      'kaspi_refund_requires_history_ack',
      'Kaspi has no idempotency key — verify the refund/return history in the ' +
        'Kaspi app before processing; a blind retry may double-refund. Re-submit ' +
        'with acknowledge_kaspi_history_checked=true once the history is verified.',
    );
  }
}
