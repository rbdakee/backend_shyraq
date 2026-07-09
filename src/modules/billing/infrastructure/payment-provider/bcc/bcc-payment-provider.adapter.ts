import { Injectable } from '@nestjs/common';
import {
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProviderPort,
  RefundInput,
  RefundResult,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from '../payment-provider.port';

/**
 * Registry anchor for BCC.
 *
 * Gate D registers the provider so deployment configuration and per-tenant
 * availability can be exercised. Gate E/F/G replace these fail-closed
 * operation bodies with checkout, callback and refund implementations.
 */
@Injectable()
export class BccPaymentProvider extends PaymentProviderPort {
  createPayment(_input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return Promise.reject(new Error('bcc_checkout_not_implemented'));
  }

  verifyWebhook(_input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    return Promise.reject(new Error('bcc_callback_not_implemented'));
  }

  refund(_input: RefundInput): Promise<RefundResult> {
    return Promise.reject(new Error('bcc_refund_not_implemented'));
  }
}
