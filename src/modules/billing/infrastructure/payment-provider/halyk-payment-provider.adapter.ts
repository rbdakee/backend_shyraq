import { Injectable, Logger } from '@nestjs/common';
import {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderPort,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './payment-provider.port';

/**
 * HalykPaymentProvider — placeholder. Phase B / B14 will implement real
 * Halyk ePay redirect + webhook verification with the merchant credentials
 * supplied via `HALYK_*` env vars. Until then every method throws so a
 * misconfigured `PAYMENT_PROVIDER=halyk` deployment fails loudly instead of
 * silently dropping payments.
 *
 * The adapter is only constructed when `PAYMENT_PROVIDER=halyk` — see the
 * `useFactory` branch in `BillingModule`.
 */
@Injectable()
export class HalykPaymentProvider extends PaymentProviderPort {
  private readonly logger = new Logger('HalykPaymentProvider');

  createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return Promise.reject(this.notImplemented('createPayment'));
  }

  verifyWebhook(_input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    return Promise.reject(this.notImplemented('verifyWebhook'));
  }

  refund(_input: RefundInput): Promise<RefundResult> {
    return Promise.reject(this.notImplemented('refund'));
  }

  private notImplemented(method: string): Error {
    this.logger.error(`[Halyk] ${method} not implemented (B14)`);
    return new Error(
      'Halyk ePay adapter not implemented; configure PAYMENT_PROVIDER=mock or implement adapter (B14)',
    );
  }
}
