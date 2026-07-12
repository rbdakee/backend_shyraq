/**
 * PaymentProviderPort — abstraction over payment-gateway integrations.
 *
 * Business code (`payment.service`, controllers, DTOs) imports only this
 * port. Vendor SDKs (Halyk ePay, Kaspi, FreedomPay, TipTopPay) live behind
 * adapter classes selected per operation by `PaymentProviderRegistry`.
 *
 * Contract notes:
 *   - `createPayment` is invoked from `payment.service.initiate`. The Mock
 *     adapter completes synchronously (status='completed') so e2e flows do
 *     not require a separate webhook step. Real adapters return 'initiated'
 *     and rely on `verifyWebhook` for completion.
 *   - `verifyWebhook` runs cross-tenant under bypass_rls — see
 *     `payment.service.processWebhook`. It MUST throw a domain error
 *     (`WebhookSignatureInvalidError`) on signature mismatch so the
 *     controller maps to 400.
 *   - `refund` is invoked from `refund.service.process` after the operator
 *     has approved the refund row. Mock processes synchronously; real
 *     adapters may queue and notify via webhook (B14+).
 */

export interface CreatePaymentInput {
  /**
   * Local payment id. Browser-based providers use it to bind an opaque
   * checkout session to the exact persisted payment row.
   */
  paymentId?: string;
  /**
   * Owning kindergarten. Required by per-tenant adapters (Kaspi resolves the
   * kindergarten's merchant session + encrypted creds at call time). The Mock
   * and Halyk adapters ignore it — backward-compatible.
   */
  kindergartenId: string;
  invoiceId: string;
  amountKzt: number;
  currency: 'KZT';
  returnUrl: string;
  payerUserId?: string;
  /**
   * Payer phone (digits). Required by `kaspi_pay` (`remote/create.PhoneNumber`);
   * ignored by Mock/Halyk. The DTO-level 400 guard lands in K7; the Kaspi
   * adapter also guards (throws `KaspiPhoneRequiredError` when absent).
   */
  phoneNumber?: string;
  /** BCC-only confirmed billing details; never used as the login identity. */
  billingPhone?: string;
  billingAddress?: string;
  /**
   * Human-readable payment purpose shown to the payer (Kaspi `remote/create`
   * `Comment` — the line the customer sees in their Kaspi app). Non-PII. When
   * absent the Kaspi adapter falls back to the invoiceId UUID. Ignored by
   * Mock/Halyk.
   */
  comment?: string;
  idempotencyKey: string;
}

export interface CreatePaymentResult {
  providerPaymentId: string;
  redirectUrl?: string;
  deeplink?: string;
  /** Sanitized identifiers required by later provider operations. */
  providerPayload?: Record<string, unknown>;
  status: 'initiated' | 'completed' | 'failed';
}

export interface ExistingPaymentContinuationInput {
  kindergartenId: string;
  paymentId: string;
}

export interface ExistingPaymentContinuation {
  redirectUrl?: string;
  deeplink?: string;
}

export interface VerifyWebhookInput {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
  /** Opaque account-routing token carried only by provider-specific routes. */
  callbackToken?: string;
}

export interface VerifyWebhookResult {
  providerPaymentId: string;
  status: 'processing' | 'completed' | 'failed';
  failureReason?: string;
  raw: Record<string, unknown>;
  /** Trusted context established by a provider adapter before DB lookup. */
  callbackContext?: {
    kindergartenId: string;
    amountKzt: number;
    currency: string;
  };
}

export interface RefundInput {
  /**
   * Owning kindergarten. Required by per-tenant adapters (Kaspi resolves the
   * kindergarten's merchant session at call time). Mock/Halyk ignore it.
   */
  kindergartenId: string;
  providerPaymentId: string;
  amountKzt: number;
  reason: string;
  idempotencyKey: string;
  /**
   * Original captured amount of the payment being refunded. BCC's `TRTYPE=14`
   * MAC signs over `ORG_AMOUNT` (the full original purchase total) even for a
   * partial refund. `RefundService` sets it from the payment aggregate;
   * Mock/Halyk/Kaspi ignore it.
   */
  originalAmountKzt?: number;
  /**
   * Sanitized provider payload persisted on the ORIGINAL payment. BCC's
   * settlement (callback + `TRTYPE=90` reconciliation) merges the original
   * `rrn`/`int_ref` here; the BCC refund reads them to build `TRTYPE=14`.
   * Never carries PAN/CVC — diagnostic identifiers only. Other adapters
   * ignore it.
   */
  originalProviderData?: Record<string, unknown> | null;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'processed';
}

export interface CancelPaymentInput {
  /** Owning kindergarten — per-tenant adapters (Kaspi) resolve the session. */
  kindergartenId: string;
  /** The provider operation id (Kaspi `QrOperationId`) to recall. */
  providerPaymentId: string;
}

export abstract class PaymentProviderPort {
  abstract createPayment(
    input: CreatePaymentInput,
  ): Promise<CreatePaymentResult>;
  abstract verifyWebhook(
    input: VerifyWebhookInput,
  ): Promise<VerifyWebhookResult>;
  abstract refund(input: RefundInput): Promise<RefundResult>;

  /**
   * Recovers a still-live provider continuation for an idempotent `/pay`
   * retry. Browser checkout providers override this to verify that their
   * short-lived session still exists; others use the persisted payload.
   */
  getExistingPaymentContinuation(
    _input: ExistingPaymentContinuationInput,
  ): Promise<ExistingPaymentContinuation | null> {
    return Promise.resolve(null);
  }

  /**
   * Recall a still-pending provider payment so a fresh one can be created
   * without leaving two live requests on the payer's side — the single-parent
   * double-pay guard (`payment.service.initiate`). Default: no-op. Providers
   * without a recall API (Mock completes synchronously; Halyk uses a redirect
   * the user simply abandons) let the stale request expire. Kaspi overrides it
   * (`POST qrpay/v01/remote/cancel { qrOperationId }`).
   */
  cancelPayment(_input: CancelPaymentInput): Promise<void> {
    return Promise.resolve();
  }
}
