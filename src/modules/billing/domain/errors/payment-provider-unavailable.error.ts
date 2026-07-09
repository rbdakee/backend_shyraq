import { DomainError } from '@/shared-kernel/domain/errors';
import type { PaymentProvider } from '../entities/payment.entity';

/**
 * The requested provider is known to the API but is not enabled for new
 * payments in this deployment.
 */
export class PaymentProviderUnavailableError extends DomainError {
  public readonly details: { provider: PaymentProvider };

  constructor(provider: PaymentProvider) {
    super('payment_provider_unavailable', 'payment_provider_unavailable');
    this.details = { provider };
  }
}
