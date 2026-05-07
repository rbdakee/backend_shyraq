import { MockFiscalReceiptAdapter } from './mock-fiscal-receipt.adapter';

const KG = '11111111-1111-1111-1111-111111111111';
const PAYMENT = '22222222-2222-2222-2222-222222222222';
const INVOICE = '33333333-3333-3333-3333-333333333333';
const PAID_AT = new Date('2026-06-15T10:30:00.000Z');

describe('MockFiscalReceiptAdapter', () => {
  let adapter: MockFiscalReceiptAdapter;

  beforeEach(() => {
    adapter = new MockFiscalReceiptAdapter();
  });

  it('returns deterministic fiscalSign shape, queued status, and qrUrl with the sign embedded', async () => {
    const result = await adapter.emitReceipt({
      paymentId: PAYMENT,
      invoiceId: INVOICE,
      kindergartenId: KG,
      amountKzt: 50000,
      paidAt: PAID_AT,
    });

    expect(result.fiscalSign).toMatch(/^mock_fiscal_[0-9a-f]{16}$/);
    expect(result.ofdStatus).toBe('queued');
    expect(result.qrUrl).toContain(result.fiscalSign);
  });

  it('produces a different fiscalSign on each call (randomness)', async () => {
    const a = await adapter.emitReceipt({
      paymentId: PAYMENT,
      invoiceId: INVOICE,
      kindergartenId: KG,
      amountKzt: 50000,
      paidAt: PAID_AT,
    });
    const b = await adapter.emitReceipt({
      paymentId: PAYMENT,
      invoiceId: INVOICE,
      kindergartenId: KG,
      amountKzt: 50000,
      paidAt: PAID_AT,
    });
    expect(a.fiscalSign).not.toBe(b.fiscalSign);
    expect(a.qrUrl).not.toBe(b.qrUrl);
  });

  it('passes through optional payerName and payerPhone without affecting result shape', async () => {
    const result = await adapter.emitReceipt({
      paymentId: PAYMENT,
      invoiceId: INVOICE,
      kindergartenId: KG,
      amountKzt: 75000,
      paidAt: PAID_AT,
      payerName: 'Aigerim Bekova',
      payerPhone: '+77001234567',
    });
    expect(result.fiscalSign).toMatch(/^mock_fiscal_[0-9a-f]{16}$/);
    expect(result.ofdStatus).toBe('queued');
  });
});
