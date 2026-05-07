import { randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { WebhookSignatureInvalidError } from '../../domain/errors';
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
 * MockPaymentProvider — default `PAYMENT_PROVIDER=mock` adapter.
 *
 * Synchronously completes payments (no async webhook step required) so the
 * dev/test/demo flow can exercise the full happy-path without mocking the
 * gateway's callback machinery. Real adapters (Halyk ePay etc.) return
 * `'initiated'` and require `verifyWebhook` for completion — production code
 * must therefore handle both shapes.
 *
 * Webhook signature: header `x-mock-signature: 'valid'` is the only accepted
 * value; anything else throws `WebhookSignatureInvalidError`.
 */
@Injectable()
export class MockPaymentProvider extends PaymentProviderPort {
  private readonly logger = new Logger('MockPaymentProvider');

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const providerPaymentId = `mock_${input.invoiceId}_${randomBytes(8).toString('hex')}`;
    this.logger.log(
      `[MockPayment] createPayment invoice=${input.invoiceId} amount=${input.amountKzt} → ${providerPaymentId}`,
    );
    return Promise.resolve({
      providerPaymentId,
      redirectUrl: `https://mock.shyraq.local/pay/${providerPaymentId}`,
      status: 'completed',
    });
  }

  verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
    const sigHeader = input.headers['x-mock-signature'];
    const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (sig !== 'valid') {
      return Promise.reject(new WebhookSignatureInvalidError('mock'));
    }

    const body = (input.body ?? {}) as Record<string, unknown>;
    const providerPaymentId =
      (body.provider_payment_id as string | undefined) ??
      (body.invoice_id as string | undefined);
    const status = body.status as 'completed' | 'failed' | undefined;
    if (
      typeof providerPaymentId !== 'string' ||
      providerPaymentId === '' ||
      (status !== 'completed' && status !== 'failed')
    ) {
      return Promise.reject(new WebhookSignatureInvalidError('mock'));
    }

    const failureReason =
      typeof body.failure_reason === 'string' ? body.failure_reason : undefined;
    return Promise.resolve({
      providerPaymentId,
      status,
      failureReason,
      raw: body,
    });
  }

  refund(input: RefundInput): Promise<RefundResult> {
    const providerRefundId = `mock_refund_${randomBytes(8).toString('hex')}`;
    this.logger.log(
      `[MockPayment] refund txn=${input.providerPaymentId} amount=${input.amountKzt} → ${providerRefundId}`,
    );
    return Promise.resolve({
      providerRefundId,
      status: 'processed',
    });
  }
}
