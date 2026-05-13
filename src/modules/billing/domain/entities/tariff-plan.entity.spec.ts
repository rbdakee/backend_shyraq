import { TariffPlan, TariffPlanState } from './tariff-plan.entity';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');

function makePlan(overrides: Partial<TariffPlanState> = {}): TariffPlanState {
  return {
    id: 'tp-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    name: 'Full Day',
    description: { ru: 'Полный день', kk: 'Толық күн' },
    tariffType: 'monthly',
    amount: 100_000,
    currency: 'KZT',
    appliesTo: 'all_children',
    groupId: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    isActive: true,
    validFrom: new Date('2026-01-01'),
    validUntil: null,
    discountRules: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('TariffPlan domain entity', () => {
  it('constructs successfully with appliesTo=all_children', () => {
    expect(() => TariffPlan.fromState(makePlan())).not.toThrow();
  });

  it('throws when appliesTo=group and groupId is null', () => {
    expect(() =>
      TariffPlan.fromState(makePlan({ appliesTo: 'group', groupId: null })),
    ).toThrow(/groupId is required/);
  });

  it('constructs successfully with appliesTo=group and a groupId', () => {
    expect(() =>
      TariffPlan.fromState(
        makePlan({ appliesTo: 'group', groupId: 'group-uuid-001' }),
      ),
    ).not.toThrow();
  });

  it('throws when appliesTo=age_range and ageMinMonths is null', () => {
    expect(() =>
      TariffPlan.fromState(
        makePlan({
          appliesTo: 'age_range',
          ageMinMonths: null,
          ageMaxMonths: 36,
        }),
      ),
    ).toThrow(/ageMinMonths and ageMaxMonths are required/);
  });

  it('throws when appliesTo=age_range and ageMin > ageMax', () => {
    expect(() =>
      TariffPlan.fromState(
        makePlan({
          appliesTo: 'age_range',
          ageMinMonths: 60,
          ageMaxMonths: 36,
        }),
      ),
    ).toThrow(/ageMinMonths must be <= ageMaxMonths/);
  });

  it('constructs successfully when ageMin equals ageMax', () => {
    expect(() =>
      TariffPlan.fromState(
        makePlan({
          appliesTo: 'age_range',
          ageMinMonths: 36,
          ageMaxMonths: 36,
        }),
      ),
    ).not.toThrow();
  });

  it('throws when validUntil is before validFrom', () => {
    expect(() =>
      TariffPlan.fromState(
        makePlan({
          validFrom: new Date('2026-02-01'),
          validUntil: new Date('2026-01-01'),
        }),
      ),
    ).toThrow(/validUntil must be >= validFrom/);
  });

  it('constructs successfully when validUntil equals validFrom (single-day)', () => {
    expect(() =>
      TariffPlan.fromState(
        makePlan({
          validFrom: new Date('2026-02-01'),
          validUntil: new Date('2026-02-01'),
        }),
      ),
    ).not.toThrow();
  });

  describe('deactivate', () => {
    it('flips isActive to false and stamps validUntil to today (UTC date-only)', () => {
      const plan = TariffPlan.fromState(makePlan());
      plan.deactivate(LATER);
      expect(plan.isActive).toBe(false);
      expect(plan.validUntil).not.toBeNull();
      expect(plan.validUntil!.getUTCFullYear()).toBe(2026);
      expect(plan.validUntil!.getUTCMonth()).toBe(4);
      expect(plan.validUntil!.getUTCDate()).toBe(7);
      expect(plan.validUntil!.getUTCHours()).toBe(0);
      expect(plan.updatedAt).toBe(LATER);
    });
  });

  it('round-trips state through fromState and toState', () => {
    const state = makePlan({
      appliesTo: 'group',
      groupId: 'g-uuid-1',
      discountRules: {
        sibling_discount_pct: 10,
        prepay_3m_pct: 5,
        prepay_6m_pct: 8,
        prepay_12m_pct: 12,
        prepay_24m_pct: 15,
        benefit_category: 'low_income',
      },
    });
    const plan = TariffPlan.fromState(state);
    expect(plan.toState()).toEqual(state);
  });
});
