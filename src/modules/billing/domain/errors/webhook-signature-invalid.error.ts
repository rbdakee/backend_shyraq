import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — incoming payment-provider webhook failed signature verification
 * via `PaymentProviderPort.verifyWebhook`. The body / headers do not match
 * the configured provider secret. Mapped to BAD_REQUEST so the provider
 * retries with a fresh signed payload.
 */
export class WebhookSignatureInvalidError extends InvariantViolationError {
  public readonly details: { provider: string };

  constructor(provider: string) {
    super('webhook_signature_invalid');
    this.details = { provider };
  }
}
