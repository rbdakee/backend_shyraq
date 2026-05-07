import { DiscountEvaluationInput } from './discount-engine.port';
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
});
