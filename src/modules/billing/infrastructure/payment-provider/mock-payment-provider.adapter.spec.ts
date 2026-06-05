import { WebhookSignatureInvalidError } from '../../domain/errors';
import { MockPaymentProvider } from './mock-payment-provider.adapter';

const INVOICE_ID = '11111111-1111-1111-1111-111111111111';
const KG_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

describe('MockPaymentProvider', () => {
  let adapter: MockPaymentProvider;

  beforeEach(() => {
    adapter = new MockPaymentProvider();
  });

  describe('createPayment', () => {
    it('returns providerPaymentId in mock_<invoiceId>_<16hex> shape with synchronous completed status', async () => {
      const result = await adapter.createPayment({
        kindergartenId: KG_ID,
        invoiceId: INVOICE_ID,
        amountKzt: 50000,
        currency: 'KZT',
        returnUrl: 'https://app.shyraq.local/return',
        idempotencyKey: 'idem-1',
      });

      expect(result.status).toBe('completed');
      expect(result.providerPaymentId).toMatch(
        new RegExp(`^mock_${INVOICE_ID}_[0-9a-f]{16}$`),
      );
      expect(result.redirectUrl).toContain(result.providerPaymentId);
    });

    it('produces a different providerPaymentId on each call', async () => {
      const a = await adapter.createPayment({
        kindergartenId: KG_ID,
        invoiceId: INVOICE_ID,
        amountKzt: 50000,
        currency: 'KZT',
        returnUrl: 'https://app.shyraq.local/return',
        idempotencyKey: 'idem-a',
      });
      const b = await adapter.createPayment({
        kindergartenId: KG_ID,
        invoiceId: INVOICE_ID,
        amountKzt: 50000,
        currency: 'KZT',
        returnUrl: 'https://app.shyraq.local/return',
        idempotencyKey: 'idem-b',
      });
      expect(a.providerPaymentId).not.toBe(b.providerPaymentId);
    });
  });

  describe('verifyWebhook', () => {
    it('accepts x-mock-signature=valid with completed body', async () => {
      const result = await adapter.verifyWebhook({
        headers: { 'x-mock-signature': 'valid' },
        body: {
          provider_payment_id: 'mock_abc_0123456789abcdef',
          status: 'completed',
        },
      });

      expect(result).toEqual({
        providerPaymentId: 'mock_abc_0123456789abcdef',
        status: 'completed',
        failureReason: undefined,
        raw: {
          provider_payment_id: 'mock_abc_0123456789abcdef',
          status: 'completed',
        },
      });
    });

    it('throws WebhookSignatureInvalidError when signature header is missing', async () => {
      await expect(
        adapter.verifyWebhook({
          headers: {},
          body: {
            provider_payment_id: 'mock_abc_0123456789abcdef',
            status: 'completed',
          },
        }),
      ).rejects.toBeInstanceOf(WebhookSignatureInvalidError);
    });

    it('throws WebhookSignatureInvalidError when signature header is invalid', async () => {
      await expect(
        adapter.verifyWebhook({
          headers: { 'x-mock-signature': 'invalid' },
          body: {
            provider_payment_id: 'mock_abc_0123456789abcdef',
            status: 'completed',
          },
        }),
      ).rejects.toBeInstanceOf(WebhookSignatureInvalidError);
    });

    it('returns failureReason when body.status=failed and failure_reason is set', async () => {
      const result = await adapter.verifyWebhook({
        headers: { 'x-mock-signature': 'valid' },
        body: {
          provider_payment_id: 'mock_abc_0123456789abcdef',
          status: 'failed',
          failure_reason: 'insufficient_funds',
        },
      });

      expect(result.status).toBe('failed');
      expect(result.failureReason).toBe('insufficient_funds');
    });

    it('throws WebhookSignatureInvalidError when body has no provider_payment_id and no invoice_id', async () => {
      await expect(
        adapter.verifyWebhook({
          headers: { 'x-mock-signature': 'valid' },
          body: { status: 'completed' },
        }),
      ).rejects.toBeInstanceOf(WebhookSignatureInvalidError);
    });

    it('throws WebhookSignatureInvalidError when body.status is not completed or failed', async () => {
      await expect(
        adapter.verifyWebhook({
          headers: { 'x-mock-signature': 'valid' },
          body: {
            provider_payment_id: 'mock_abc_0123456789abcdef',
            status: 'pending',
          },
        }),
      ).rejects.toBeInstanceOf(WebhookSignatureInvalidError);
    });
  });

  describe('refund', () => {
    it('returns providerRefundId in mock_refund_<16hex> shape with processed status', async () => {
      const result = await adapter.refund({
        kindergartenId: KG_ID,
        providerPaymentId: 'mock_abc_0123456789abcdef',
        amountKzt: 50000,
        reason: 'parent_requested',
        idempotencyKey: 'refund-1',
      });

      expect(result.status).toBe('processed');
      expect(result.providerRefundId).toMatch(/^mock_refund_[0-9a-f]{16}$/);
    });

    it('produces a different providerRefundId on each call', async () => {
      const a = await adapter.refund({
        kindergartenId: KG_ID,
        providerPaymentId: 'mock_abc_0123456789abcdef',
        amountKzt: 50000,
        reason: 'r',
        idempotencyKey: 'refund-a',
      });
      const b = await adapter.refund({
        kindergartenId: KG_ID,
        providerPaymentId: 'mock_abc_0123456789abcdef',
        amountKzt: 50000,
        reason: 'r',
        idempotencyKey: 'refund-b',
      });
      expect(a.providerRefundId).not.toBe(b.providerRefundId);
    });

    it('returns the same providerRefundId on duplicate idempotency key (T11 H1)', async () => {
      const a = await adapter.refund({
        kindergartenId: KG_ID,
        providerPaymentId: 'mock_abc_0123456789abcdef',
        amountKzt: 50000,
        reason: 'r',
        idempotencyKey: 'refund-dup',
      });
      const b = await adapter.refund({
        kindergartenId: KG_ID,
        providerPaymentId: 'mock_abc_0123456789abcdef',
        amountKzt: 50000,
        reason: 'r',
        idempotencyKey: 'refund-dup',
      });
      expect(b.providerRefundId).toBe(a.providerRefundId);
    });
  });

  describe('createPayment idempotency (T11 H1)', () => {
    it('returns the same providerPaymentId on duplicate idempotency key', async () => {
      const a = await adapter.createPayment({
        kindergartenId: KG_ID,
        invoiceId: INVOICE_ID,
        amountKzt: 50000,
        currency: 'KZT',
        returnUrl: 'https://app.shyraq.local/return',
        idempotencyKey: 'create-dup',
      });
      const b = await adapter.createPayment({
        kindergartenId: KG_ID,
        invoiceId: INVOICE_ID,
        amountKzt: 50000,
        currency: 'KZT',
        returnUrl: 'https://app.shyraq.local/return',
        idempotencyKey: 'create-dup',
      });
      expect(b.providerPaymentId).toBe(a.providerPaymentId);
    });
  });
});
