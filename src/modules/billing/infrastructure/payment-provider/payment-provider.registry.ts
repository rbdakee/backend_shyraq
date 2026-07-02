import type { PaymentProvider } from '../../domain/entities/payment.entity';
import { PaymentProviderUnavailableError } from '../../domain/errors/payment-provider-unavailable.error';
import { PaymentProviderPort } from './payment-provider.port';

export interface PaymentProviderRegistration {
  provider: PaymentProvider;
  adapter: PaymentProviderPort;
}

const CONFIG_ALIASES: Readonly<Record<string, PaymentProvider>> = {
  mock: 'mock',
  halyk: 'halyk_epay',
  halyk_epay: 'halyk_epay',
  kaspi: 'kaspi_pay',
  kaspi_pay: 'kaspi_pay',
  tiptoppay: 'tiptoppay',
  freedompay: 'freedom_pay',
  freedom_pay: 'freedom_pay',
  bcc: 'bcc',
};

/**
 * PAYMENT_PROVIDERS is the multi-provider setting. The singular
 * PAYMENT_PROVIDER remains a backwards-compatible fallback so existing
 * deployments keep their current behaviour until their env is migrated.
 */
export function configuredPaymentProviders(
  env: NodeJS.ProcessEnv = process.env,
): PaymentProvider[] {
  const raw =
    env.PAYMENT_PROVIDERS?.trim() || env.PAYMENT_PROVIDER?.trim() || 'mock';
  const configured = raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (configured.length === 0) {
    throw new Error('PAYMENT_PROVIDERS must contain at least one provider');
  }

  const normalized = configured.map((value) => {
    const provider = CONFIG_ALIASES[value];
    if (!provider) {
      throw new Error(
        `Unknown payment provider "${value}" in PAYMENT_PROVIDERS`,
      );
    }
    return provider;
  });

  return [...new Set(normalized)];
}

/**
 * Routes each operation to the adapter that owns that payment.
 *
 * Enabled providers govern only NEW payment initiation. Registered adapters
 * remain available for late webhooks, cancellation and refunds after a
 * provider has been disabled for new payments.
 */
export class PaymentProviderRegistry {
  private readonly adapters = new Map<PaymentProvider, PaymentProviderPort>();
  private readonly enabled = new Set<PaymentProvider>();

  constructor(
    registrations: PaymentProviderRegistration[],
    enabledProviders: PaymentProvider[],
  ) {
    for (const registration of registrations) {
      if (this.adapters.has(registration.provider)) {
        throw new Error(
          `Duplicate payment provider registration: ${registration.provider}`,
        );
      }
      this.adapters.set(registration.provider, registration.adapter);
    }

    for (const provider of enabledProviders) {
      if (!this.adapters.has(provider)) {
        throw new Error(
          `PAYMENT_PROVIDERS enables "${provider}", but no adapter is registered`,
        );
      }
      this.enabled.add(provider);
    }
  }

  forInitiation(provider: PaymentProvider): PaymentProviderPort {
    if (!this.enabled.has(provider)) {
      throw new PaymentProviderUnavailableError(provider);
    }
    return this.forExistingOperation(provider);
  }

  forExistingOperation(provider: PaymentProvider): PaymentProviderPort {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new PaymentProviderUnavailableError(provider);
    }
    return adapter;
  }

  isEnabled(provider: PaymentProvider): boolean {
    return this.enabled.has(provider);
  }

  enabledProviders(): PaymentProvider[] {
    return [...this.enabled];
  }
}
