import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — generic vendor-side payment provider failure surfaced through the
 * `PaymentProviderPort`. Mapped to BAD_REQUEST via the
 * `InvariantViolationError` base because the provider rejected our
 * request — the caller should normally retry or escalate to the admin.
 *
 * The provider-specific reason is preserved on `details.reason` for
 * client-side rendering / log forwarding.
 */
export class PaymentProviderError extends InvariantViolationError {
  public readonly details: { provider: string; reason: string };

  constructor(provider: string, reason: string) {
    super('payment_provider_error');
    this.details = { provider, reason };
  }
}
