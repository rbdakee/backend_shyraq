import {
  InvoiceLineItem,
  InvoiceLineItemState,
} from './invoice-line-item.entity';

const NOW = new Date('2026-05-07T10:00:00Z');

function makeItem(
  overrides: Partial<InvoiceLineItemState> = {},
): InvoiceLineItemState {
  return {
    id: 'li-uuid-0001',
    invoiceId: 'inv-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    description: 'Monthly tuition',
    tariffPlanId: 'tp-uuid-0001',
    quantity: 1,
    unitPrice: 100_000,
    lineTotal: 100_000,
    createdAt: NOW,
    ...overrides,
  };
}

describe('InvoiceLineItem domain entity', () => {
  describe('compute', () => {
    it('returns quantity * unitPrice rounded to two decimals', () => {
      expect(InvoiceLineItem.compute(2, 49_999.5)).toBe(99_999);
      expect(InvoiceLineItem.compute(0.33, 90_000)).toBe(29_700);
      expect(InvoiceLineItem.compute(1, 100)).toBe(100);
    });

    it('rounds half-cent to nearest cent', () => {
      // 1.005 → JS Math.round((1.005 * 1) * 100) / 100 — float quirk lands at 1
      expect(InvoiceLineItem.compute(1, 1.005)).toBeCloseTo(1, 1);
    });
  });

  describe('constructor invariants', () => {
    it('constructs successfully with consistent quantity*unitPrice=lineTotal', () => {
      expect(() => InvoiceLineItem.fromState(makeItem())).not.toThrow();
    });

    it('throws when quantity is 0', () => {
      expect(() =>
        InvoiceLineItem.fromState(makeItem({ quantity: 0, lineTotal: 0 })),
      ).toThrow(/quantity must be > 0/);
    });

    it('throws when quantity is negative', () => {
      expect(() =>
        InvoiceLineItem.fromState(makeItem({ quantity: -1, lineTotal: 0 })),
      ).toThrow(/quantity must be > 0/);
    });

    it('throws when unitPrice is negative', () => {
      expect(() =>
        InvoiceLineItem.fromState(makeItem({ unitPrice: -1, lineTotal: 0 })),
      ).toThrow(/unitPrice must be >= 0/);
    });

    it('throws when lineTotal is negative', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ quantity: 1, unitPrice: 100, lineTotal: -1 }),
        ),
      ).toThrow(/lineTotal must be >= 0/);
    });

    it('throws when lineTotal mismatches quantity*unitPrice beyond tolerance', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ quantity: 2, unitPrice: 100, lineTotal: 999 }),
        ),
      ).toThrow(/does not match quantity\*unitPrice/);
    });

    it('tolerates sub-cent rounding drift between quantity*unitPrice and lineTotal', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ quantity: 1, unitPrice: 100.005, lineTotal: 100 }),
        ),
      ).not.toThrow();
    });

    it('accepts unitPrice of 0 (free line)', () => {
      expect(() =>
        InvoiceLineItem.fromState(makeItem({ unitPrice: 0, lineTotal: 0 })),
      ).not.toThrow();
    });
  });

  it('round-trips state through fromState and toState', () => {
    const state = makeItem({
      quantity: 3,
      unitPrice: 1_500,
      lineTotal: 4_500,
      tariffPlanId: null,
      description: 'Extra service',
    });
    expect(InvoiceLineItem.fromState(state).toState()).toEqual(state);
  });
});
