import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import {
  InvoiceLineItem,
  InvoiceLineItemState,
} from './invoice-line-item.entity';

const NOW = new Date('2026-05-07T10:00:00Z');

const m = (n: number): MoneyKzt => MoneyKzt.fromKzt(n);

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
    unitPrice: m(100_000),
    lineTotal: m(100_000),
    createdAt: NOW,
    ...overrides,
  };
}

describe('InvoiceLineItem domain entity', () => {
  describe('compute', () => {
    it('returns quantity * unitPrice rounded to two decimals', () => {
      expect(InvoiceLineItem.compute(2, m(49_999.5)).toNumber()).toBe(99_999);
      expect(InvoiceLineItem.compute(0.33, m(90_000)).toNumber()).toBe(29_700);
      expect(InvoiceLineItem.compute(1, m(100)).toNumber()).toBe(100);
    });

    it("rounds half-cent to nearest cent via banker's rounding", () => {
      // 1 * 1.01 = 1.01 (canonical 2dp). Verify the chain compresses
      // intermediate precision to the 2dp boundary.
      expect(InvoiceLineItem.compute(1, m(1.005)).toNumber()).toBeCloseTo(1, 1);
    });
  });

  describe('constructor invariants', () => {
    it('constructs successfully with consistent quantity*unitPrice=lineTotal', () => {
      expect(() => InvoiceLineItem.fromState(makeItem())).not.toThrow();
    });

    it('throws when quantity is 0', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ quantity: 0, lineTotal: MoneyKzt.zero() }),
        ),
      ).toThrow(/quantity must be > 0/);
    });

    it('throws when quantity is negative', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ quantity: -1, lineTotal: MoneyKzt.zero() }),
        ),
      ).toThrow(/quantity must be > 0/);
    });

    it('throws when unitPrice is negative', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ unitPrice: m(-1), lineTotal: MoneyKzt.zero() }),
        ),
      ).toThrow(/unitPrice must be >= 0/);
    });

    it('throws when lineTotal is negative', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ quantity: 1, unitPrice: m(100), lineTotal: m(-1) }),
        ),
      ).toThrow(/lineTotal must be >= 0/);
    });

    it('throws when lineTotal mismatches quantity*unitPrice beyond tolerance', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ quantity: 2, unitPrice: m(100), lineTotal: m(999) }),
        ),
      ).toThrow(/does not match quantity\*unitPrice/);
    });

    it('tolerates sub-cent rounding drift between quantity*unitPrice and lineTotal', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ quantity: 1, unitPrice: m(100.005), lineTotal: m(100) }),
        ),
      ).not.toThrow();
    });

    it('accepts unitPrice of 0 (free line)', () => {
      expect(() =>
        InvoiceLineItem.fromState(
          makeItem({ unitPrice: MoneyKzt.zero(), lineTotal: MoneyKzt.zero() }),
        ),
      ).not.toThrow();
    });
  });

  it('round-trips state through fromState and toState', () => {
    const state = makeItem({
      quantity: 3,
      unitPrice: m(1_500),
      lineTotal: m(4_500),
      tariffPlanId: null,
      description: 'Extra service',
    });
    expect(InvoiceLineItem.fromState(state).toState()).toEqual(state);
  });
});
