import { PaymentProviderUnavailableError } from '../../domain/errors/payment-provider-unavailable.error';
import { PaymentProviderPort } from './payment-provider.port';
import {
  configuredPaymentProviders,
  PaymentProviderRegistry,
} from './payment-provider.registry';

function adapter(): PaymentProviderPort {
  return {} as PaymentProviderPort;
}

describe('PaymentProviderRegistry', () => {
  it('keeps legacy singular PAYMENT_PROVIDER compatibility', () => {
    expect(
      configuredPaymentProviders({
        PAYMENT_PROVIDER: 'kaspi',
      } as NodeJS.ProcessEnv),
    ).toEqual(['kaspi_pay']);
  });

  it('normalizes and de-duplicates PAYMENT_PROVIDERS', () => {
    expect(
      configuredPaymentProviders({
        PAYMENT_PROVIDER: 'mock',
        PAYMENT_PROVIDERS: 'kaspi, halyk_epay, kaspi',
      } as NodeJS.ProcessEnv),
    ).toEqual(['kaspi_pay', 'halyk_epay']);
  });

  it('routes new payments only to enabled providers', () => {
    const mock = adapter();
    const kaspi = adapter();
    const registry = new PaymentProviderRegistry(
      [
        { provider: 'mock', adapter: mock },
        { provider: 'kaspi_pay', adapter: kaspi },
      ],
      ['kaspi_pay'],
    );

    expect(registry.forInitiation('kaspi_pay')).toBe(kaspi);
    expect(() => registry.forInitiation('mock')).toThrow(
      PaymentProviderUnavailableError,
    );
  });

  it('keeps disabled adapters available for late webhooks and refunds', () => {
    const mock = adapter();
    const kaspi = adapter();
    const registry = new PaymentProviderRegistry(
      [
        { provider: 'mock', adapter: mock },
        { provider: 'kaspi_pay', adapter: kaspi },
      ],
      ['kaspi_pay'],
    );

    expect(registry.forExistingOperation('mock')).toBe(mock);
  });

  it('fails startup when an enabled provider has no adapter', () => {
    expect(() => new PaymentProviderRegistry([], ['bcc'])).toThrow(
      'PAYMENT_PROVIDERS enables "bcc", but no adapter is registered',
    );
  });

  it('boots with kaspi and bcc enabled together (Gate H)', () => {
    expect(
      configuredPaymentProviders({
        PAYMENT_PROVIDERS: 'kaspi,bcc',
      } as NodeJS.ProcessEnv),
    ).toEqual(['kaspi_pay', 'bcc']);

    const kaspi = adapter();
    const bcc = adapter();
    const registry = new PaymentProviderRegistry(
      [
        { provider: 'kaspi_pay', adapter: kaspi },
        { provider: 'bcc', adapter: bcc },
      ],
      ['kaspi_pay', 'bcc'],
    );

    expect(registry.forInitiation('kaspi_pay')).toBe(kaspi);
    expect(registry.forInitiation('bcc')).toBe(bcc);
    expect(registry.enabledProviders()).toEqual(['kaspi_pay', 'bcc']);
  });
});
