import {
  CustomDiscountSnapshot,
  DiscountEvaluationInput,
} from './discount-engine.port';
import { MockDiscountEngine } from './mock-discount-engine.adapter';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = '22222222-2222-2222-2222-222222222222';
const INV = '33333333-3333-3333-3333-333333333333';
const PLAN = '44444444-4444-4444-4444-444444444444';
const PERIOD_START = new Date('2026-06-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-06-30T23:59:59.999Z');

function input(
  overrides: Partial<{
    rules: DiscountEvaluationInput['tariffPlan']['discountRules'];
    context: DiscountEvaluationInput['context'];
    invoiceType: DiscountEvaluationInput['invoice']['invoiceType'];
  }> = {},
): DiscountEvaluationInput {
  return {
    invoice: {
      invoiceId: INV,
      invoiceType: overrides.invoiceType ?? 'monthly',
      childId: CHILD,
      kindergartenId: KG,
      amountDue: 100000,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
    },
    tariffPlan: {
      id: PLAN,
      discountRules: overrides.rules ?? {},
    },
    context: overrides.context ?? {},
  };
}

describe('MockDiscountEngine', () => {
  let engine: MockDiscountEngine;

  beforeEach(() => {
    engine = new MockDiscountEngine();
  });

  it('returns null discount when no rules and no context match', async () => {
    const result = await engine.evaluate(input());
    expect(result).toEqual({
      discountPct: null,
      discountReason: null,
      appliedRules: [],
      customApplicationsToWrite: [],
      customDiscountAmount: null,
    });
  });

  it('applies sibling discount when siblingsCount>1 and sibling_discount_pct is set', async () => {
    const result = await engine.evaluate(
      input({
        rules: { sibling_discount_pct: 15 },
        context: { siblingsCount: 2 },
      }),
    );
    expect(result).toEqual({
      discountPct: 15,
      discountReason: 'sibling_discount',
      appliedRules: ['sibling'],
      customApplicationsToWrite: [],
      customDiscountAmount: null,
    });
  });

  it('skips sibling discount when siblingsCount=1 (the child is alone)', async () => {
    const result = await engine.evaluate(
      input({
        rules: { sibling_discount_pct: 15 },
        context: { siblingsCount: 1 },
      }),
    );
    expect(result.discountPct).toBeNull();
    expect(result.appliedRules).toEqual([]);
  });

  it('applies prepay discount when prepaymentMonths matches a configured prepay_<n>m_pct key', async () => {
    const result = await engine.evaluate(
      input({
        rules: { prepay_12m_pct: 10 },
        context: { prepaymentMonths: 12 },
        invoiceType: 'prepayment_12m',
      }),
    );
    expect(result).toEqual({
      discountPct: 10,
      discountReason: 'prepay_12m',
      appliedRules: ['prepay_12m'],
      customApplicationsToWrite: [],
      customDiscountAmount: null,
    });
  });

  it('stacks sibling + prepay additively when both rules match', async () => {
    const result = await engine.evaluate(
      input({
        rules: { sibling_discount_pct: 15, prepay_12m_pct: 10 },
        context: { siblingsCount: 2, prepaymentMonths: 12 },
        invoiceType: 'prepayment_12m',
      }),
    );
    expect(result.discountPct).toBe(25);
    expect(result.discountReason).toBe('sibling_discount,prepay_12m');
    expect(result.appliedRules).toEqual(['sibling', 'prepay_12m']);
  });

  it('caps stacked total at 100', async () => {
    const result = await engine.evaluate(
      input({
        rules: { sibling_discount_pct: 70, prepay_24m_pct: 60 },
        context: { siblingsCount: 3, prepaymentMonths: 24 },
        invoiceType: 'prepayment_24m',
      }),
    );
    expect(result.discountPct).toBe(100);
    expect(result.appliedRules).toEqual(['sibling', 'prepay_24m']);
  });

  it('returns null when discountRules is empty even if context demands it', async () => {
    const result = await engine.evaluate(
      input({
        rules: {},
        context: { siblingsCount: 5, prepaymentMonths: 12 },
      }),
    );
    expect(result).toEqual({
      discountPct: null,
      discountReason: null,
      appliedRules: [],
      customApplicationsToWrite: [],
      customDiscountAmount: null,
    });
  });

  it('skips prepay when configured pct is 0 (rule effectively disabled)', async () => {
    const result = await engine.evaluate(
      input({
        rules: { prepay_3m_pct: 0 },
        context: { prepaymentMonths: 3 },
      }),
    );
    expect(result.discountPct).toBeNull();
  });

  // ── B16 T8 H3 — corrected stacking semantics ────────────────────────────
  //
  // Rule: sort by priority DESC. If TOP is non-stackable → only top.
  // Otherwise apply contiguous stackable prefix (gate at first non-stackable).
  describe('custom-discount stacking (H3)', () => {
    function snap(
      id: string,
      priority: number,
      stackable: boolean,
      amount = 10,
      type: 'percentage' | 'fixed_amount' = 'percentage',
    ): CustomDiscountSnapshot {
      return {
        id,
        name: { ru: id },
        discountType: type,
        amount,
        conditions: {} as never,
        targetType: 'all',
        targetIds: null,
        priority,
        stackable,
        maxUsesPerChild: null,
        totalMaxUses: null,
        usedCount: 0,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
    }

    const evalCtx = {
      childContext: {
        birthDate: new Date('2022-01-01'),
        ageInMonths: 48,
        currentGroupId: null,
        benefitCategory: null,
      },
      familyContext: { siblingsInKgCount: 1, isFirstInvoiceForChild: false },
    };

    it('top non-stackable wins outright (NS at top)', async () => {
      const result = await engine.evaluate(
        input({
          context: {
            ...evalCtx,
            customDiscounts: [
              snap('A', 200, false, 10), // top, NS
              snap('B', 100, true, 5),
              snap('C', 50, true, 5),
            ],
          },
        }),
      );
      expect(
        result.customApplicationsToWrite.map((a) => a.customDiscountId),
      ).toEqual(['A']);
    });

    it('NS in the middle gates further stacking — prefix of stackables wins', async () => {
      const result = await engine.evaluate(
        input({
          context: {
            ...evalCtx,
            customDiscounts: [
              snap('A', 200, true, 5),
              snap('B', 150, true, 3),
              snap('C', 100, false, 2), // gate
              snap('D', 50, true, 5), // never reached
            ],
          },
        }),
      );
      const ids = result.customApplicationsToWrite.map(
        (a) => a.customDiscountId,
      );
      expect(ids).toEqual(['A', 'B']);
    });

    it('NS at bottom — all stackables before it apply', async () => {
      const result = await engine.evaluate(
        input({
          context: {
            ...evalCtx,
            customDiscounts: [
              snap('A', 200, true, 5),
              snap('B', 150, true, 3),
              snap('C', 100, false, 2),
            ],
          },
        }),
      );
      const ids = result.customApplicationsToWrite.map(
        (a) => a.customDiscountId,
      );
      expect(ids).toEqual(['A', 'B']);
    });

    it('all stackable — full stack', async () => {
      const result = await engine.evaluate(
        input({
          context: {
            ...evalCtx,
            customDiscounts: [
              snap('A', 200, true, 5),
              snap('B', 150, true, 3),
              snap('C', 100, true, 2),
            ],
          },
        }),
      );
      const ids = result.customApplicationsToWrite.map(
        (a) => a.customDiscountId,
      );
      expect(ids).toEqual(['A', 'B', 'C']);
    });

    it('all non-stackable — only top wins', async () => {
      const result = await engine.evaluate(
        input({
          context: {
            ...evalCtx,
            customDiscounts: [
              snap('A', 200, false, 5),
              snap('B', 150, false, 3),
              snap('C', 100, false, 2),
            ],
          },
        }),
      );
      const ids = result.customApplicationsToWrite.map(
        (a) => a.customDiscountId,
      );
      expect(ids).toEqual(['A']);
    });
  });

  // ── B16 T8 SO-1 — custom discount AMOUNT precision ─────────────────────
  //
  // Bug: 3333 KZT custom discount on 100000 invoice. Engine emits
  // discountPct = round((3333 / 100000) * 100, 2) = 3.33%. Then
  // computeAmountAfterDiscount(100000, 3.33) = 96670 → discount = 3330,
  // not 3333. Fix carries `customDiscountAmount` absolute KZT through.
  describe('customDiscountAmount precision (SO-1)', () => {
    const evalCtx = {
      childContext: {
        birthDate: new Date('2022-01-01'),
        ageInMonths: 48,
        currentGroupId: null,
        benefitCategory: null,
      },
      familyContext: { siblingsInKgCount: 1, isFirstInvoiceForChild: false },
    };

    function fxSnap(amount: number): CustomDiscountSnapshot {
      return {
        id: 'fx-1',
        name: { ru: 'Fx' },
        discountType: 'fixed_amount',
        amount,
        conditions: {} as never,
        targetType: 'all',
        targetIds: null,
        priority: 100,
        stackable: false,
        maxUsesPerChild: null,
        totalMaxUses: null,
        usedCount: 0,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      };
    }

    it('emits absolute customDiscountAmount equal to fixed_amount input', async () => {
      const result = await engine.evaluate(
        input({
          context: { ...evalCtx, customDiscounts: [fxSnap(3333)] },
        }),
      );
      expect(result.customDiscountAmount).toBe(3333);
      expect(result.customApplicationsToWrite[0].amountApplied).toBe(3333);
    });

    it('customDiscountAmount is null when no custom rules matched', async () => {
      const result = await engine.evaluate(input());
      expect(result.customDiscountAmount).toBeNull();
    });

    it('customDiscountAmount sums all stacked custom amounts', async () => {
      const result = await engine.evaluate(
        input({
          context: {
            ...evalCtx,
            customDiscounts: [
              {
                ...fxSnap(2000),
                id: 'fx-1',
                priority: 200,
                stackable: true,
              },
              {
                ...fxSnap(1333),
                id: 'fx-2',
                priority: 100,
                stackable: true,
              },
            ],
          },
        }),
      );
      expect(result.customDiscountAmount).toBe(3333);
    });
  });
});
