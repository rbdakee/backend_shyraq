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
  status: 'initiated' | 'completed' | 'failed';
}

export interface VerifyWebhookInput {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
}

export interface VerifyWebhookResult {
  providerPaymentId: string;
  status: 'completed' | 'failed';
  failureReason?: string;
  raw: Record<string, unknown>;
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
