import { Module, Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DiscountEnginePort } from './infrastructure/discount-engine/discount-engine.port';
import { MockDiscountEngine } from './infrastructure/discount-engine/mock-discount-engine.adapter';
import { FiscalReceiptPort } from './infrastructure/fiscal-receipt/fiscal-receipt.port';
import { MockFiscalReceiptAdapter } from './infrastructure/fiscal-receipt/mock-fiscal-receipt.adapter';
import { HalykPaymentProvider } from './infrastructure/payment-provider/halyk-payment-provider.adapter';
import { MockPaymentProvider } from './infrastructure/payment-provider/mock-payment-provider.adapter';
import { PaymentProviderPort } from './infrastructure/payment-provider/payment-provider.port';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';
import { InvoiceLineItemRepository } from './infrastructure/persistence/invoice-line-item.repository';
import { KindergartenHolidayRepository } from './infrastructure/persistence/kindergarten-holiday.repository';
import { PaymentAccountRepository } from './infrastructure/persistence/payment-account.repository';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { TariffAssignmentRepository } from './infrastructure/persistence/tariff-assignment.repository';
import { TariffPlanRepository } from './infrastructure/persistence/tariff-plan.repository';
import { InvoiceRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice.relational.repository';
import { InvoiceLineItemRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice-line-item.relational.repository';
import { KindergartenHolidayRelationalRepository } from './infrastructure/persistence/relational/repositories/kindergarten-holiday.relational.repository';
import { PaymentAccountRelationalRepository } from './infrastructure/persistence/relational/repositories/payment-account.relational.repository';
import { PaymentRelationalRepository } from './infrastructure/persistence/relational/repositories/payment.relational.repository';
import { TariffAssignmentRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-assignment.relational.repository';
import { TariffPlanRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-plan.relational.repository';
import { InvoiceTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice.typeorm.entity';
import { InvoiceLineItemTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice-line-item.typeorm.entity';
import { KindergartenHolidayTypeOrmEntity } from './infrastructure/persistence/relational/entities/kindergarten-holiday.typeorm.entity';
import { PaymentAccountTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment-account.typeorm.entity';
import { PaymentTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment.typeorm.entity';
import { RefundTypeOrmEntity } from './infrastructure/persistence/relational/entities/refund.typeorm.entity';
import { TariffAssignmentTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-assignment.typeorm.entity';
import { TariffPlanTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-plan.typeorm.entity';
import { HolidayService } from './holiday.service';
import { InvoiceService } from './invoice.service';
import { PaymentAccountService } from './payment-account.service';
import { TariffAssignmentService } from './tariff-assignment.service';
import { TariffPlanService } from './tariff-plan.service';

/**
 * Picks the payment-provider adapter based on `process.env.PAYMENT_PROVIDER`.
 * Defaults to `mock`. `halyk` resolves to the B14 stub which throws on every
 * call — running with `PAYMENT_PROVIDER=halyk` is intentionally loud so a
 * misconfigured deployment fails before silently dropping payments.
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
 * T3 wired only ports + advisory-lock-only repository implementations.
 * T4a expands the surface to the full CRUD + auto-generation services
 * (`TariffPlan`, `TariffAssignment`, `Holiday`, `PaymentAccount`,
 * `Invoice`) and registers the eight TypeORM entities with `forFeature`.
 *
 * `Payment` and `Refund` entities are registered now so adjacent services
 * (T5a/T5b) can `@InjectRepository` them once they land — but their own
 * services + repositories are not yet provided.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TariffPlanTypeOrmEntity,
      TariffAssignmentTypeOrmEntity,
      PaymentAccountTypeOrmEntity,
      InvoiceTypeOrmEntity,
      InvoiceLineItemTypeOrmEntity,
      PaymentTypeOrmEntity,
      RefundTypeOrmEntity,
      KindergartenHolidayTypeOrmEntity,
    ]),
  ],
  providers: [
    paymentProviderProvider(),
    { provide: DiscountEnginePort, useClass: MockDiscountEngine },
    fiscalReceiptProvider(),
    { provide: InvoiceRepository, useClass: InvoiceRelationalRepository },
    {
      provide: InvoiceLineItemRepository,
      useClass: InvoiceLineItemRelationalRepository,
    },
    { provide: PaymentRepository, useClass: PaymentRelationalRepository },
    { provide: TariffPlanRepository, useClass: TariffPlanRelationalRepository },
    {
      provide: TariffAssignmentRepository,
      useClass: TariffAssignmentRelationalRepository,
    },
    {
      provide: PaymentAccountRepository,
      useClass: PaymentAccountRelationalRepository,
    },
    {
      provide: KindergartenHolidayRepository,
      useClass: KindergartenHolidayRelationalRepository,
    },
    InvoiceService,
    TariffPlanService,
    TariffAssignmentService,
    HolidayService,
    PaymentAccountService,
  ],
  exports: [
    PaymentProviderPort,
    DiscountEnginePort,
    FiscalReceiptPort,
    InvoiceRepository,
    InvoiceLineItemRepository,
    PaymentRepository,
    TariffPlanRepository,
    TariffAssignmentRepository,
    PaymentAccountRepository,
    KindergartenHolidayRepository,
    InvoiceService,
    TariffPlanService,
    TariffAssignmentService,
    HolidayService,
    PaymentAccountService,
  ],
})
export class BillingModule {}
