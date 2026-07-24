import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Invoice, InvoiceState } from './domain/entities/invoice.entity';
import { InvoicePresenter } from './invoice.presenter';

const m = (n: number): MoneyKzt => MoneyKzt.fromKzt(n);
const NOW = new Date('2026-06-01T09:00:00.000Z');

function makeInvoice(overrides: Partial<InvoiceState> = {}): Invoice {
  return Invoice.fromState({
    id: 'i-1',
    kindergartenId: 'kg-1',
    childId: 'child-1',
    paymentAccountId: 'acc-1',
    tariffPlanId: null,
    invoiceType: 'monthly',
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    amountDue: m(120000),
    discountPct: 10,
    discountReason: null,
    amountAfterDiscount: m(108000),
    status: 'partial',
    dueDate: new Date('2026-06-10T00:00:00.000Z'),
    description: null,
    proratedForDays: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('InvoicePresenter.one — amount_paid / amount_remaining', () => {
  it('defaults amount_paid to 0 and amount_remaining to the full net when no paid sum is passed', () => {
    const dto = InvoicePresenter.one(makeInvoice({ status: 'pending' }));
    expect(dto.amount_paid).toBe(0);
    expect(dto.amount_remaining).toBe(108000);
  });

  it('splits a partial payment into paid and remaining slices', () => {
    const dto = InvoicePresenter.one(makeInvoice(), undefined, 50000);
    expect(dto.amount_paid).toBe(50000);
    expect(dto.amount_remaining).toBe(58000);
  });

  it('reports 0 remaining once the paid sum reaches the net amount', () => {
    const dto = InvoicePresenter.one(
      makeInvoice({ status: 'paid' }),
      undefined,
      108000,
    );
    expect(dto.amount_paid).toBe(108000);
    expect(dto.amount_remaining).toBe(0);
  });

  it('clamps amount_remaining to 0 when the paid sum exceeds the net (sub-tenge overpay)', () => {
    // amount_after_discount 13.50 but the provider charged a whole 14 tenge.
    const dto = InvoicePresenter.one(
      makeInvoice({
        amountDue: m(15),
        discountPct: 10,
        amountAfterDiscount: m(13.5),
      }),
      undefined,
      14,
    );
    expect(dto.amount_paid).toBe(14);
    expect(dto.amount_remaining).toBe(0);
  });
});

describe('InvoicePresenter.list — paid-sum overlay', () => {
  it('threads per-invoice paid sums from the map and defaults missing ids to 0', () => {
    const a = makeInvoice({ id: 'i-a' });
    const b = makeInvoice({ id: 'i-b' });
    const paidSums = new Map<string, number>([['i-a', 40000]]);

    const res = InvoicePresenter.list([a, b], null, paidSums);

    const dtoA = res.items.find((i) => i.id === 'i-a')!;
    const dtoB = res.items.find((i) => i.id === 'i-b')!;
    expect(dtoA.amount_paid).toBe(40000);
    expect(dtoA.amount_remaining).toBe(68000);
    expect(dtoB.amount_paid).toBe(0);
    expect(dtoB.amount_remaining).toBe(108000);
  });
});
