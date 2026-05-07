/**
 * PaymentProviderPort — abstraction over payment-gateway integrations.
 *
 * Business code (`payment.service`, controllers, DTOs) imports only this
 * port. Vendor SDKs (Halyk ePay, Kaspi, FreedomPay, TipTopPay) live behind
 * adapter classes selected via `PAYMENT_PROVIDER` env at module bootstrap.
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
  invoiceId: string;
  amountKzt: number;
  currency: 'KZT';
  returnUrl: string;
  payerUserId?: string;
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
  providerPaymentId: string;
  amountKzt: number;
  reason: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'processed';
}

export abstract class PaymentProviderPort {
  abstract createPayment(
    input: CreatePaymentInput,
  ): Promise<CreatePaymentResult>;
  abstract verifyWebhook(
    input: VerifyWebhookInput,
  ): Promise<VerifyWebhookResult>;
  abstract refund(input: RefundInput): Promise<RefundResult>;
}
