import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Payment } from './domain/entities/payment.entity';
import {
  BccCheckoutSession,
  BccCheckoutStorePort,
} from './infrastructure/checkout/bcc-checkout-store.port';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { BccCheckoutService } from './bcc-checkout.service';

const KG = '00000000-0000-4000-8000-000000000001';
const PAYMENT = '00000000-0000-4000-8000-000000000002';
const ORDER = '12345678901234567890';

function checkoutSession(): BccCheckoutSession {
  return {
    paymentId: PAYMENT,
    kindergartenId: KG,
    order: ORDER,
    gatewayUrl: 'https://test3ds.bcc.kz:5445/cgi-bin/cgi_link',
    formFields: { ORDER, TRTYPE: '1', P_SIGN: 'ABC' },
    billingPhone: '+77011234567',
    billingAddress: 'Алматы',
  };
}

function payment(overrides: Record<string, unknown> = {}): Payment {
  const now = new Date('2026-07-06T08:00:00.000Z');
  return Payment.fromState({
    id: PAYMENT,
    kindergartenId: KG,
    invoiceId: '00000000-0000-4000-8000-000000000003',
    childId: '00000000-0000-4000-8000-000000000004',
    payerUserId: '00000000-0000-4000-8000-000000000005',
    amount: MoneyKzt.fromKzt(350),
    provider: 'bcc',
    providerTxnId: ORDER,
    idempotencyKey: '00000000-0000-4000-8000-000000000006',
    status: 'processing',
    providerPayload: null,
    paidAt: null,
    refundId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe('BccCheckoutService', () => {
  it('renders only a session bound to the exact BCC payment and tenant', async () => {
    const service = new BccCheckoutService(
      {
        consume: () => Promise.resolve(checkoutSession()),
      } as unknown as BccCheckoutStorePort,
      {
        findByIdCrossTenant: () => Promise.resolve(payment()),
      } as unknown as PaymentRepository,
    );

    const page = await service.consume('opaque-token', '203.0.113.10');
    expect(page.html).toContain('name="ORDER"');
    expect(page.html).toContain('value="203.0.113.10"');
  });

  it('rejects an expired or already consumed token', async () => {
    const service = new BccCheckoutService(
      {
        consume: () => Promise.resolve(null),
      } as unknown as BccCheckoutStorePort,
      {} as PaymentRepository,
    );

    await expect(
      service.consume('opaque-token', '203.0.113.10'),
    ).rejects.toMatchObject({
      code: 'bcc_checkout_expired',
    });
  });

  it('rejects a session whose order does not match the persisted payment', async () => {
    const service = new BccCheckoutService(
      {
        consume: () => Promise.resolve(checkoutSession()),
      } as unknown as BccCheckoutStorePort,
      {
        findByIdCrossTenant: () =>
          Promise.resolve(payment({ providerTxnId: '9999999' })),
      } as unknown as PaymentRepository,
    );

    await expect(
      service.consume('opaque-token', '203.0.113.10'),
    ).rejects.toMatchObject({
      code: 'bcc_checkout_expired',
    });
  });
});
