import { Module, Provider } from '@nestjs/common';
import { DiscountEnginePort } from './infrastructure/discount-engine/discount-engine.port';
import { MockDiscountEngine } from './infrastructure/discount-engine/mock-discount-engine.adapter';
import { FiscalReceiptPort } from './infrastructure/fiscal-receipt/fiscal-receipt.port';
import { MockFiscalReceiptAdapter } from './infrastructure/fiscal-receipt/mock-fiscal-receipt.adapter';
import { HalykPaymentProvider } from './infrastructure/payment-provider/halyk-payment-provider.adapter';
import { MockPaymentProvider } from './infrastructure/payment-provider/mock-payment-provider.adapter';
import { PaymentProviderPort } from './infrastructure/payment-provider/payment-provider.port';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { InvoiceRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice.relational.repository';
import { PaymentRelationalRepository } from './infrastructure/persistence/relational/repositories/payment.relational.repository';

/**
 * Picks the payment-provider adapter based on `process.env.PAYMENT_PROVIDER`.
 * Defaults to `mock`. `halyk` resolves to the B14 stub which throws on every
 * call — running with `PAYMENT_PROVIDER=halyk` is intentionally loud so a
 * misconfigured deployment fails before silently dropping payments.
 *
 * Phase B will add `kaspi` / `tiptoppay` / `freedompay` branches alongside
 * Halyk. Bootstrapping a new vendor is one branch + one adapter file — the
 * business code (`payment.service`, controllers, DTOs) is untouched.
 */
function paymentProviderProvider(): Provider {
  return {
    provide: PaymentProviderPort,
    useFactory: () => {
      const provider = (process.env.PAYMENT_PROVIDER ?? 'mock').toLowerCase();
      if (provider === 'halyk') {
        return new HalykPaymentProvider();
      }
      if (provider !== 'mock') {
        throw new Error(
          `Unknown PAYMENT_PROVIDER=${provider}; valid: mock|halyk`,
        );
      }
      return new MockPaymentProvider();
    },
  };
}

/**
 * Picks the OFD adapter based on `process.env.FISCAL_PROVIDER`. B13 ships
 * only the Mock impl; B15 will add Kassa24 / Rekassa / Webkassa branches.
 * The factory throws on any unknown value so a typo surfaces at bootstrap
 * rather than at the first emit.
 */
function fiscalReceiptProvider(): Provider {
  return {
    provide: FiscalReceiptPort,
    useFactory: () => {
      const provider = (process.env.FISCAL_PROVIDER ?? 'mock').toLowerCase();
      if (provider !== 'mock') {
        throw new Error(
          `Unknown FISCAL_PROVIDER=${provider}; valid: mock (B15 will add real adapters)`,
        );
      }
      return new MockFiscalReceiptAdapter();
    },
  };
}

/**
 * BillingModule (B13).
 *
 * T3 wires only ports + adapters + advisory-lock-only repository
 * implementations. CRUD + service layer + controllers + DTOs arrive in
 * T4–T7. The module is registered in `AppModule` now so the DI graph
 * compiles end-to-end before T4 lands — service classes added later inject
 * the already-exported ports without further wiring changes.
 *
 * `DiscountEnginePort` does not currently need an env-switch (B13 ships
 * only the Mock impl). B16 will introduce a `RuleBasedDiscountEngine` and
 * a `DISCOUNT_ENGINE` env var at that point — until then `useClass` is
 * preferable to a single-branch `useFactory` (no boilerplate, no risk of
 * silent typo on an unset env var).
 */
@Module({
  providers: [
    paymentProviderProvider(),
    { provide: DiscountEnginePort, useClass: MockDiscountEngine },
    fiscalReceiptProvider(),
    { provide: InvoiceRepository, useClass: InvoiceRelationalRepository },
    { provide: PaymentRepository, useClass: PaymentRelationalRepository },
  ],
  exports: [
    PaymentProviderPort,
    DiscountEnginePort,
    FiscalReceiptPort,
    InvoiceRepository,
    PaymentRepository,
  ],
})
export class BillingModule {}
