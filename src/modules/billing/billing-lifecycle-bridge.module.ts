import { Global, Module } from '@nestjs/common';
import { BillingLifecyclePort } from '@/modules/child/infrastructure/billing-lifecycle.port';
import { BillingModule } from './billing.module';
import { BillingLifecycleAdapter } from './infrastructure/billing-lifecycle.adapter';

/**
 * BillingLifecycleBridgeModule — `@Global()` shim that overrides the
 * default `BillingLifecyclePort` no-op binding (registered inside
 * `ChildModule`) with the real adapter that reaches into the billing
 * stack to close tariff assignments on archive.
 *
 * Why a separate module instead of putting `@Global()` on `BillingModule`
 * directly: the billing module already exports a wide surface
 * (`InvoiceService`, repositories, queues) and making it global would
 * change the visibility of every binding. The bridge keeps the
 * `@Global()` reach narrow — only the lifecycle port crosses module
 * boundaries here.
 *
 * Must be imported into `AppModule` AFTER `BillingModule` so the
 * `TariffAssignmentRepository` provider exists in the container when
 * the adapter is instantiated.
 */
@Global()
@Module({
  imports: [BillingModule],
  providers: [
    { provide: BillingLifecyclePort, useClass: BillingLifecycleAdapter },
  ],
  exports: [BillingLifecyclePort],
})
export class BillingLifecycleBridgeModule {}
