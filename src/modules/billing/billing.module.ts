import { Module, Provider } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { LIFECYCLE_QUEUE } from '@/modules/child/lifecycle-queue.constants';
import { CustomDiscountRepository } from './custom-discount.repository';
import { CustomDiscountApplicationRepository } from './custom-discount-application.repository';
import { CustomDiscountService } from './custom-discount.service';
import { DiscountTargetResolver } from './discount-target-resolver';
import {
  DiscountExpireProcessor,
  DiscountExpireScheduler,
  DISCOUNT_EXPIRE_QUEUE,
} from './discount-expire.processor';
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
import { RefundRepository } from './infrastructure/persistence/refund.repository';
import { TariffAssignmentRepository } from './infrastructure/persistence/tariff-assignment.repository';
import { TariffPlanRepository } from './infrastructure/persistence/tariff-plan.repository';
import { CustomDiscountRelationalRepository } from './infrastructure/persistence/relational/repositories/custom-discount.relational.repository';
import { CustomDiscountApplicationRelationalRepository } from './infrastructure/persistence/relational/repositories/custom-discount-application.relational.repository';
import { InvoiceRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice.relational.repository';
import { InvoiceLineItemRelationalRepository } from './infrastructure/persistence/relational/repositories/invoice-line-item.relational.repository';
import { KindergartenHolidayRelationalRepository } from './infrastructure/persistence/relational/repositories/kindergarten-holiday.relational.repository';
import { PaymentAccountRelationalRepository } from './infrastructure/persistence/relational/repositories/payment-account.relational.repository';
import { PaymentRelationalRepository } from './infrastructure/persistence/relational/repositories/payment.relational.repository';
import { RefundRelationalRepository } from './infrastructure/persistence/relational/repositories/refund.relational.repository';
import { TariffAssignmentRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-assignment.relational.repository';
import { TariffPlanRelationalRepository } from './infrastructure/persistence/relational/repositories/tariff-plan.relational.repository';
import { CustomDiscountTypeOrmEntity } from './infrastructure/persistence/relational/entities/custom-discount.typeorm.entity';
import { CustomDiscountApplicationTypeOrmEntity } from './infrastructure/persistence/relational/entities/custom-discount-application.typeorm.entity';
import { InvoiceTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice.typeorm.entity';
import { InvoiceLineItemTypeOrmEntity } from './infrastructure/persistence/relational/entities/invoice-line-item.typeorm.entity';
import { KindergartenHolidayTypeOrmEntity } from './infrastructure/persistence/relational/entities/kindergarten-holiday.typeorm.entity';
import { PaymentAccountTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment-account.typeorm.entity';
import { PaymentTypeOrmEntity } from './infrastructure/persistence/relational/entities/payment.typeorm.entity';
import { RefundTypeOrmEntity } from './infrastructure/persistence/relational/entities/refund.typeorm.entity';
import { TariffAssignmentTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-assignment.typeorm.entity';
import { TariffPlanTypeOrmEntity } from './infrastructure/persistence/relational/entities/tariff-plan.typeorm.entity';
import { AdminCustomDiscountController } from './admin-custom-discount.controller';
import { AdminFiscalReceiptController } from './admin-fiscal-receipt.controller';
import { AdminHolidayController } from './admin-holiday.controller';
import { AdminInvoiceController } from './admin-invoice.controller';
import { AdminPaymentController } from './admin-payment.controller';
import { AdminRefundController } from './admin-refund.controller';
import { AdminTariffAssignmentController } from './admin-tariff-assignment.controller';
import { AdminTariffPlanController } from './admin-tariff-plan.controller';
import { ParentInvoiceController } from './parent-invoice.controller';
import { ParentPaymentController } from './parent-payment.controller';
import { PaymentWebhookController } from './payment-webhook.controller';
import { HolidayService } from './holiday.service';
import { InvoiceService } from './invoice.service';
import { MonthlyBillingScheduler } from './monthly-billing-scheduler.service';
import {
  MonthlyBillingProcessor,
  MONTHLY_BILLING_QUEUE,
} from './monthly-billing.processor';
import { ProRataRefundProcessor } from './pro-rata-refund.processor';
import { PaymentAccountService } from './payment-account.service';
import { PaymentService } from './payment.service';
import { RefundService } from './refund.service';
import { SaasBillingController } from './saas-billing.controller';
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
 * T4a expanded the surface to the full CRUD + auto-generation services
 * (`TariffPlan`, `TariffAssignment`, `Holiday`, `PaymentAccount`,
 * `Invoice`) and registered the eight TypeORM entities with `forFeature`.
 * T5a added `PaymentService` + `PaymentRepository`. T5b adds
 * `RefundService` + `RefundRepository`.
 *
 * Outbox notifications + fiscal-receipt emission + nanny-policy
 * filtering land in T5c; the admin HTTP controller for refunds is wired
 * by T7a.
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
      // ── B16 Custom Discounts ───────────────────────────────────────
      CustomDiscountTypeOrmEntity,
      CustomDiscountApplicationTypeOrmEntity,
    ]),
    // BullMQ queue for the monthly billing cron + manual super-admin
    // trigger. The recurring schedule is registered by
    // `MonthlyBillingScheduler` (gated by `BILLING_MONTHLY_CRON !=
    // 'disabled'`) at OnApplicationBootstrap; T7a's saas controller
    // pushes one-off `MONTHLY_BILLING_MANUAL_JOB` jobs via
    // `@InjectQueue(MONTHLY_BILLING_QUEUE)`.
    BullModule.registerQueue({ name: MONTHLY_BILLING_QUEUE }),
    // B16 — discount-expire cron + manual trigger. Same gating + manual
    // override pattern as the monthly run. The processor +
    // scheduler live in `discount-expire.processor.ts`.
    BullModule.registerQueue({ name: DISCOUNT_EXPIRE_QUEUE }),
    // B21 T3 step4 — host the ProRataRefundProcessor on the same
    // `lifecycle` queue ChildService publishes to. Worker process picks
    // up `lifecycle:pro-rata-refund` jobs and creates the pro-rata
    // refund row in the child's current billing period.
    BullModule.registerQueue({ name: LIFECYCLE_QUEUE }),
    // T7b: ChildModule re-exports `ChildGuardianRepository` so the parent
    // controllers can re-check guardian-of-child links + nanny role gate.
    ChildModule,
  ],
  controllers: [
    // Admin-side surface (KindergartenScopeGuard + RolesGuard@admin).
    AdminTariffPlanController,
    AdminTariffAssignmentController,
    AdminInvoiceController,
    AdminPaymentController,
    AdminRefundController,
    AdminHolidayController,
    AdminFiscalReceiptController,
    // B16 Custom Discounts admin surface.
    AdminCustomDiscountController,
    // Super-admin trigger (SuperAdminScope + RolesGuard@super_admin/support).
    SaasBillingController,
    // T7b: parent-side surface (JwtAuthGuard + Roles@parent + per-route
    // guardian re-check) + cross-tenant payment webhook (@Public).
    ParentInvoiceController,
    ParentPaymentController,
    PaymentWebhookController,
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
    { provide: RefundRepository, useClass: RefundRelationalRepository },
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
    // ── B16 Custom Discounts ─────────────────────────────────────────
    {
      provide: CustomDiscountRepository,
      useClass: CustomDiscountRelationalRepository,
    },
    {
      provide: CustomDiscountApplicationRepository,
      useClass: CustomDiscountApplicationRelationalRepository,
    },
    InvoiceService,
    TariffPlanService,
    TariffAssignmentService,
    HolidayService,
    PaymentAccountService,
    PaymentService,
    RefundService,
    CustomDiscountService,
    DiscountTargetResolver,
    MonthlyBillingProcessor,
    MonthlyBillingScheduler,
    DiscountExpireProcessor,
    DiscountExpireScheduler,
    ProRataRefundProcessor,
  ],
  exports: [
    PaymentProviderPort,
    DiscountEnginePort,
    FiscalReceiptPort,
    InvoiceRepository,
    InvoiceLineItemRepository,
    PaymentRepository,
    RefundRepository,
    TariffPlanRepository,
    TariffAssignmentRepository,
    PaymentAccountRepository,
    KindergartenHolidayRepository,
    CustomDiscountRepository,
    CustomDiscountApplicationRepository,
    InvoiceService,
    TariffPlanService,
    TariffAssignmentService,
    HolidayService,
    PaymentAccountService,
    PaymentService,
    RefundService,
    CustomDiscountService,
    DiscountTargetResolver,
    // Re-export the queue token via the BullMQ module so T7a's saas
    // controller can `@InjectQueue(MONTHLY_BILLING_QUEUE)` from any
    // module that imports BillingModule.
    BullModule,
  ],
})
export class BillingModule {}
