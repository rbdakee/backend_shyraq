import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * 502 — generic vendor-side payment provider failure surfaced through the
 * `PaymentProviderPort`. The DomainErrorFilter maps this to
 * BAD_GATEWAY with a sanitized public message (`payment_provider_error`)
 * — the raw provider reason is preserved on `details.reason` for server-
 * side log forwarding only and is NOT included in the response body.
 *
 * Why 502, not 400 (T11 H5):
 *   - The provider call failed on their side; our request was syntactically
 *     valid. 400 would imply the caller mis-formatted the request.
 *   - 502 (Bad Gateway) is the conventional RFC code for upstream
 *     dependency failures. Clients can use it as a retry signal.
 *   - The previous mapping (via InvariantViolationError → 400) leaked
 *     the provider's raw error message verbatim through `error`/`message`
 *     fields. The dedicated filter branch now sanitizes the body.
 */
export class PaymentProviderError extends DomainError {
  public readonly details: { provider: string };
  /** Server-side log only — never exposed to clients. */
  public readonly internalReason: string;

  constructor(provider: string, reason: string) {
    super('payment_provider_error', 'payment_provider_error');
    this.details = { provider };
    this.internalReason = reason;
  }
}
