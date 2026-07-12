import { ClassConstructor, plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { InitiatePaymentDto, InitiatePrepaymentDto } from './payment.dto';

/**
 * Provider request-alias normalization.
 *
 * A client that sends the legacy short spelling `kaspi` (instead of the
 * canonical `kaspi_pay`) previously passed `@IsEnum` on older builds but then
 * failed the registry `forInitiation` gate — which only holds the canonical
 * `kaspi_pay` — with `payment_provider_unavailable`. The `@Transform` on the
 * `provider` field normalizes the alias BEFORE validation, so the whole
 * pipeline (validation, the `=== 'kaspi_pay'` phone guard, the registry) sees
 * the canonical value.
 */
describe('payment DTO — provider alias normalization', () => {
  function providerOf<T extends object>(
    cls: ClassConstructor<T>,
    provider: unknown,
  ): unknown {
    return (plainToInstance(cls, { provider }) as { provider: unknown })
      .provider;
  }

  function providerErrors<T extends object>(
    cls: ClassConstructor<T>,
    provider: unknown,
  ): boolean {
    const dto = plainToInstance(cls, { provider }) as object;
    return validateSync(dto, { whitelist: true })
      .map((e) => e.property)
      .includes('provider');
  }

  it('normalizes "kaspi" to "kaspi_pay" on InitiatePaymentDto', () => {
    expect(providerOf(InitiatePaymentDto, 'kaspi')).toBe('kaspi_pay');
    expect(providerErrors(InitiatePaymentDto, 'kaspi')).toBe(false);
  });

  it('normalizes "kaspi" to "kaspi_pay" on InitiatePrepaymentDto', () => {
    expect(providerOf(InitiatePrepaymentDto, 'kaspi')).toBe('kaspi_pay');
    expect(providerErrors(InitiatePrepaymentDto, 'kaspi')).toBe(false);
  });

  it('is case-insensitive ("KASPI" → "kaspi_pay")', () => {
    expect(providerOf(InitiatePaymentDto, 'KASPI')).toBe('kaspi_pay');
  });

  it('also normalizes the halyk/freedompay legacy aliases', () => {
    expect(providerOf(InitiatePaymentDto, 'halyk')).toBe('halyk_epay');
    expect(providerOf(InitiatePaymentDto, 'freedompay')).toBe('freedom_pay');
  });

  it('leaves canonical values untouched', () => {
    for (const p of ['kaspi_pay', 'mock', 'bcc', 'halyk_epay']) {
      expect(providerOf(InitiatePaymentDto, p)).toBe(p);
      expect(providerErrors(InitiatePaymentDto, p)).toBe(false);
    }
  });

  it('still rejects an unknown provider', () => {
    expect(providerOf(InitiatePaymentDto, 'paypal')).toBe('paypal');
    expect(providerErrors(InitiatePaymentDto, 'paypal')).toBe(true);
  });
});
