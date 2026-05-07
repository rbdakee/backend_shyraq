import { CustomDiscountConditionsInvalidError } from '../errors/custom-discount-conditions-invalid.error';
import {
  ConditionsRoot,
  EvalContext,
  evaluateConditions,
  validateConditionsSchema,
} from './conditions-evaluator';

const NOW = new Date('2026-05-07T10:00:00Z');

function makeCtx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    invoice: {
      invoiceType: 'monthly',
      periodStart: new Date('2026-05-01T00:00:00Z'),
      periodEnd: new Date('2026-05-31T23:59:59.999Z'),
      amountDue: 100_000,
      dueDate: new Date('2026-05-31T23:59:59.999Z'),
      ...overrides.invoice,
    },
    child: {
      id: 'child-uuid-0001',
      birthDate: new Date('2024-05-15T00:00:00Z'),
      currentGroupId: 'group-uuid-0001',
      ageInMonths: 24,
      benefitCategory: null,
      ...overrides.child,
    },
    family: {
      siblingsInKgCount: 0,
      isFirstInvoiceForChild: false,
      ...overrides.family,
    },
    payment: {
      ...overrides.payment,
    },
    now: overrides.now ?? NOW,
  };
}

describe('conditions evaluator', () => {
  // ── empty-object semantics ────────────────────────────────────────────

  describe('empty conditions {}', () => {
    it('returns true for {} (catalogue default — always matches)', () => {
      expect(evaluateConditions({}, makeCtx())).toBe(true);
    });
  });

  // ── prepayment_months ─────────────────────────────────────────────────

  describe('prepayment_months', () => {
    it('returns true when gte threshold met', () => {
      const cond: ConditionsRoot = {
        type: 'prepayment_months',
        op: 'gte',
        value: 6,
      };
      expect(
        evaluateConditions(cond, makeCtx({ payment: { prepaymentMonths: 6 } })),
      ).toBe(true);
      expect(
        evaluateConditions(
          cond,
          makeCtx({ payment: { prepaymentMonths: 12 } }),
        ),
      ).toBe(true);
    });

    it('returns false when prepaymentMonths missing or below threshold', () => {
      const cond: ConditionsRoot = {
        type: 'prepayment_months',
        op: 'gte',
        value: 6,
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(false);
      expect(
        evaluateConditions(cond, makeCtx({ payment: { prepaymentMonths: 3 } })),
      ).toBe(false);
    });

    it('returns true with op=eq for exact match only', () => {
      const cond: ConditionsRoot = {
        type: 'prepayment_months',
        op: 'eq',
        value: 12,
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({ payment: { prepaymentMonths: 12 } }),
        ),
      ).toBe(true);
      expect(
        evaluateConditions(
          cond,
          makeCtx({ payment: { prepaymentMonths: 11 } }),
        ),
      ).toBe(false);
    });
  });

  // ── siblings_count ────────────────────────────────────────────────────

  describe('siblings_count', () => {
    it('returns true when family has enough siblings (gte)', () => {
      const cond: ConditionsRoot = {
        type: 'siblings_count',
        op: 'gte',
        value: 2,
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({
            family: { siblingsInKgCount: 2, isFirstInvoiceForChild: false },
          }),
        ),
      ).toBe(true);
    });

    it('returns false when siblings below threshold', () => {
      const cond: ConditionsRoot = {
        type: 'siblings_count',
        op: 'gte',
        value: 2,
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({
            family: { siblingsInKgCount: 1, isFirstInvoiceForChild: false },
          }),
        ),
      ).toBe(false);
    });
  });

  // ── age_range ─────────────────────────────────────────────────────────

  describe('age_range', () => {
    it('returns true at lower-inclusive boundary', () => {
      const cond: ConditionsRoot = {
        type: 'age_range',
        from_months: 12,
        to_months: 36,
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({ child: { ageInMonths: 12 } as any }),
        ),
      ).toBe(true);
    });

    it('returns true at upper-inclusive boundary', () => {
      const cond: ConditionsRoot = {
        type: 'age_range',
        from_months: 12,
        to_months: 36,
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({ child: { ageInMonths: 36 } as any }),
        ),
      ).toBe(true);
    });

    it('returns false outside the range', () => {
      const cond: ConditionsRoot = {
        type: 'age_range',
        from_months: 12,
        to_months: 36,
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({ child: { ageInMonths: 11 } as any }),
        ),
      ).toBe(false);
      expect(
        evaluateConditions(
          cond,
          makeCtx({ child: { ageInMonths: 37 } as any }),
        ),
      ).toBe(false);
    });
  });

  // ── benefit_category ──────────────────────────────────────────────────

  describe('benefit_category', () => {
    it('returns true when child category is in the list', () => {
      const cond: ConditionsRoot = {
        type: 'benefit_category',
        in: ['multi_child', 'disability'],
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({ child: { benefitCategory: 'multi_child' } as any }),
        ),
      ).toBe(true);
    });

    it('returns false when child has no category or not in list', () => {
      const cond: ConditionsRoot = {
        type: 'benefit_category',
        in: ['multi_child'],
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(false);
      expect(
        evaluateConditions(
          cond,
          makeCtx({ child: { benefitCategory: 'single_mother' } as any }),
        ),
      ).toBe(false);
    });

    it('returns false for empty in: []', () => {
      const cond: ConditionsRoot = { type: 'benefit_category', in: [] };
      expect(
        evaluateConditions(
          cond,
          makeCtx({ child: { benefitCategory: 'multi_child' } as any }),
        ),
      ).toBe(false);
    });
  });

  // ── payment_method ────────────────────────────────────────────────────

  describe('payment_method', () => {
    it('returns true when method matches', () => {
      const cond: ConditionsRoot = {
        type: 'payment_method',
        in: ['kaspi_pay', 'cash'],
      };
      expect(
        evaluateConditions(cond, makeCtx({ payment: { method: 'kaspi_pay' } })),
      ).toBe(true);
    });

    it('returns false when method missing or not in list', () => {
      const cond: ConditionsRoot = {
        type: 'payment_method',
        in: ['kaspi_pay'],
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(false);
      expect(
        evaluateConditions(
          cond,
          makeCtx({ payment: { method: 'halyk_epay' } }),
        ),
      ).toBe(false);
    });
  });

  // ── early_payment ─────────────────────────────────────────────────────

  describe('early_payment', () => {
    it('returns true when paid early enough', () => {
      const cond: ConditionsRoot = {
        type: 'early_payment',
        days_before_due: 5,
      };
      expect(
        evaluateConditions(cond, makeCtx({ payment: { paidEarlyDays: 5 } })),
      ).toBe(true);
      expect(
        evaluateConditions(cond, makeCtx({ payment: { paidEarlyDays: 10 } })),
      ).toBe(true);
    });

    it('returns false when paid too late or unset', () => {
      const cond: ConditionsRoot = {
        type: 'early_payment',
        days_before_due: 5,
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(false);
      expect(
        evaluateConditions(cond, makeCtx({ payment: { paidEarlyDays: 4 } })),
      ).toBe(false);
    });
  });

  // ── birthday_month ────────────────────────────────────────────────────

  describe('birthday_month', () => {
    it('returns true when invoice month equals birth month', () => {
      // birthDate May 15 2024, periodStart May 2026 — both UTC month 4.
      const cond: ConditionsRoot = { type: 'birthday_month' };
      expect(evaluateConditions(cond, makeCtx())).toBe(true);
    });

    it('returns false when birth month differs from invoice month', () => {
      const cond: ConditionsRoot = { type: 'birthday_month' };
      expect(
        evaluateConditions(
          cond,
          makeCtx({
            child: {
              birthDate: new Date('2024-08-15T00:00:00Z'),
            } as any,
          }),
        ),
      ).toBe(false);
    });
  });

  // ── date_range ────────────────────────────────────────────────────────

  describe('date_range', () => {
    it('returns true within an inclusive window', () => {
      const cond: ConditionsRoot = {
        type: 'date_range',
        from: '2026-05-01',
        to: '2026-05-31',
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(true);
    });

    it('returns false outside the window', () => {
      const cond: ConditionsRoot = {
        type: 'date_range',
        from: '2026-04-01',
        to: '2026-04-30',
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(false);
    });
  });

  // ── first_invoice ─────────────────────────────────────────────────────

  describe('first_invoice', () => {
    it('returns true when this is the family first invoice for the child', () => {
      const cond: ConditionsRoot = { type: 'first_invoice' };
      expect(
        evaluateConditions(
          cond,
          makeCtx({
            family: { isFirstInvoiceForChild: true, siblingsInKgCount: 0 },
          }),
        ),
      ).toBe(true);
    });

    it('returns false when not the first invoice', () => {
      const cond: ConditionsRoot = { type: 'first_invoice' };
      expect(evaluateConditions(cond, makeCtx())).toBe(false);
    });
  });

  // ── tariff_types ──────────────────────────────────────────────────────

  describe('tariff_types', () => {
    it('returns true when invoiceType is in list', () => {
      const cond: ConditionsRoot = {
        type: 'tariff_types',
        in: ['monthly', 'prepayment_3m'],
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(true);
    });

    it('returns false when invoiceType not in list', () => {
      const cond: ConditionsRoot = {
        type: 'tariff_types',
        in: ['prepayment_24m'],
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(false);
    });
  });

  // ── composites ────────────────────────────────────────────────────────

  describe('composite all_of / any_of', () => {
    it('returns true when every nested all_of leaf matches', () => {
      const cond: ConditionsRoot = {
        all_of: [
          { type: 'first_invoice' },
          { type: 'tariff_types', in: ['monthly'] },
        ],
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({
            family: { isFirstInvoiceForChild: true, siblingsInKgCount: 0 },
          }),
        ),
      ).toBe(true);
    });

    it('returns false when one all_of leaf misses', () => {
      const cond: ConditionsRoot = {
        all_of: [
          { type: 'first_invoice' },
          { type: 'tariff_types', in: ['prepayment_12m'] },
        ],
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({
            family: { isFirstInvoiceForChild: true, siblingsInKgCount: 0 },
          }),
        ),
      ).toBe(false);
    });

    it('returns true vacuously for empty all_of: []', () => {
      const cond: ConditionsRoot = { all_of: [] };
      expect(evaluateConditions(cond, makeCtx())).toBe(true);
    });

    it('returns true when at least one any_of leaf matches', () => {
      const cond: ConditionsRoot = {
        any_of: [
          { type: 'first_invoice' },
          { type: 'tariff_types', in: ['monthly'] },
        ],
      };
      expect(evaluateConditions(cond, makeCtx())).toBe(true);
    });

    it('returns false vacuously for empty any_of: []', () => {
      const cond: ConditionsRoot = { any_of: [] };
      expect(evaluateConditions(cond, makeCtx())).toBe(false);
    });

    it('throws on depth > 3 (4 levels of nesting)', () => {
      const cond: ConditionsRoot = {
        all_of: [
          {
            all_of: [
              {
                all_of: [{ all_of: [{ type: 'first_invoice' }] }],
              },
            ],
          },
        ],
      };
      expect(() => evaluateConditions(cond, makeCtx())).toThrow(
        CustomDiscountConditionsInvalidError,
      );
    });

    it('accepts nesting up to depth 3 inclusive', () => {
      // depth 0=root all_of, 1=child all_of, 2=grandchild any_of, 3=leaf
      const cond: ConditionsRoot = {
        all_of: [
          {
            all_of: [
              {
                any_of: [{ type: 'first_invoice' }],
              },
            ],
          },
        ],
      };
      expect(
        evaluateConditions(
          cond,
          makeCtx({
            family: { isFirstInvoiceForChild: true, siblingsInKgCount: 0 },
          }),
        ),
      ).toBe(true);
    });
  });

  // ── validateConditionsSchema ──────────────────────────────────────────

  describe('validateConditionsSchema', () => {
    it('returns {} for {} input', () => {
      expect(validateConditionsSchema({})).toEqual({});
    });

    it('rejects non-object roots (array)', () => {
      expect(() => validateConditionsSchema([])).toThrow(
        CustomDiscountConditionsInvalidError,
      );
    });

    it('rejects non-object roots (null)', () => {
      expect(() => validateConditionsSchema(null)).toThrow(
        CustomDiscountConditionsInvalidError,
      );
    });

    it('rejects unknown leaf type', () => {
      expect(() =>
        validateConditionsSchema({ type: 'phase_of_the_moon', value: 'full' }),
      ).toThrow(CustomDiscountConditionsInvalidError);
    });

    it('rejects prepayment_months with non-integer value', () => {
      expect(() =>
        validateConditionsSchema({
          type: 'prepayment_months',
          op: 'gte',
          value: 1.5,
        }),
      ).toThrow(CustomDiscountConditionsInvalidError);
    });

    it('rejects age_range when from_months > to_months', () => {
      expect(() =>
        validateConditionsSchema({
          type: 'age_range',
          from_months: 36,
          to_months: 12,
        }),
      ).toThrow(CustomDiscountConditionsInvalidError);
    });

    it('rejects benefit_category with unknown value', () => {
      expect(() =>
        validateConditionsSchema({
          type: 'benefit_category',
          in: ['unknown'],
        }),
      ).toThrow(CustomDiscountConditionsInvalidError);
    });

    it('rejects date_range with malformed date', () => {
      expect(() =>
        validateConditionsSchema({
          type: 'date_range',
          from: '01-01-2026',
          to: '2026-12-31',
        }),
      ).toThrow(CustomDiscountConditionsInvalidError);
    });

    it('rejects date_range with invalid calendar date (matches regex but bogus)', () => {
      expect(() =>
        validateConditionsSchema({
          type: 'date_range',
          from: '2026-13-01',
          to: '2026-12-31',
        }),
      ).toThrow(CustomDiscountConditionsInvalidError);
    });

    it('rejects all_of children that are not arrays', () => {
      expect(() => validateConditionsSchema({ all_of: 'oops' })).toThrow(
        CustomDiscountConditionsInvalidError,
      );
    });

    it('rejects depth > 3 at validation time', () => {
      expect(() =>
        validateConditionsSchema({
          all_of: [
            {
              all_of: [
                {
                  all_of: [{ all_of: [{ type: 'first_invoice' }] }],
                },
              ],
            },
          ],
        }),
      ).toThrow(CustomDiscountConditionsInvalidError);
    });

    it('accepts and returns canonical leaf for tariff_types', () => {
      const out = validateConditionsSchema({
        type: 'tariff_types',
        in: ['monthly', 'prepayment_12m'],
      });
      expect(out).toEqual({
        type: 'tariff_types',
        in: ['monthly', 'prepayment_12m'],
      });
    });
  });
});
