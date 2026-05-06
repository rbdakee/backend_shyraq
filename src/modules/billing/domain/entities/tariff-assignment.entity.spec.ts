import {
  TariffAssignment,
  TariffAssignmentState,
} from './tariff-assignment.entity';
import { TariffPlan, TariffPlanState } from './tariff-plan.entity';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');

function makeAssignment(
  overrides: Partial<TariffAssignmentState> = {},
): TariffAssignmentState {
  return {
    id: 'ta-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    childId: 'child-uuid-0001',
    tariffPlanId: 'tp-uuid-0001',
    customAmount: null,
    customReason: null,
    validFrom: new Date('2026-01-01'),
    validUntil: null,
    assignedBy: 'staff-uuid-0001',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePlan(amount = 100_000): TariffPlan {
  const state: TariffPlanState = {
    id: 'tp-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    name: 'Plan',
    description: {},
    tariffType: 'monthly',
    amount,
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
  };
  return TariffPlan.fromState(state);
}

describe('TariffAssignment domain entity', () => {
  it('constructs successfully with no override', () => {
    expect(() => TariffAssignment.fromState(makeAssignment())).not.toThrow();
  });

  it('constructs successfully with positive customAmount', () => {
    expect(() =>
      TariffAssignment.fromState(
        makeAssignment({ customAmount: 50_000, customReason: 'discount' }),
      ),
    ).not.toThrow();
  });

  it('constructs successfully with customAmount of 0', () => {
    expect(() =>
      TariffAssignment.fromState(
        makeAssignment({ customAmount: 0, customReason: 'sponsored' }),
      ),
    ).not.toThrow();
  });

  it('throws when customAmount is negative', () => {
    expect(() =>
      TariffAssignment.fromState(makeAssignment({ customAmount: -1 })),
    ).toThrow(/customAmount must be >= 0/);
  });

  it('throws when validUntil is before validFrom', () => {
    expect(() =>
      TariffAssignment.fromState(
        makeAssignment({
          validFrom: new Date('2026-02-01'),
          validUntil: new Date('2026-01-01'),
        }),
      ),
    ).toThrow(/validUntil must be >= validFrom/);
  });

  describe('close', () => {
    it('sets validUntil to today (UTC date-only) when previously open', () => {
      const a = TariffAssignment.fromState(makeAssignment());
      a.close(LATER);
      expect(a.validUntil).not.toBeNull();
      expect(a.validUntil!.getUTCDate()).toBe(7);
      expect(a.validUntil!.getUTCHours()).toBe(0);
      expect(a.updatedAt).toBe(LATER);
    });

    it('leaves validUntil unchanged when already closed (idempotent)', () => {
      const closedAt = new Date('2026-04-30');
      const a = TariffAssignment.fromState(
        makeAssignment({ validUntil: closedAt }),
      );
      a.close(LATER);
      expect(a.validUntil).toBe(closedAt);
      expect(a.updatedAt).toBe(LATER);
    });
  });

  describe('effectiveAmount', () => {
    it('returns customAmount when set', () => {
      const a = TariffAssignment.fromState(
        makeAssignment({ customAmount: 75_000, customReason: 'sibling' }),
      );
      expect(a.effectiveAmount(makePlan(100_000))).toBe(75_000);
    });

    it('returns plan.amount when customAmount is null', () => {
      const a = TariffAssignment.fromState(makeAssignment());
      expect(a.effectiveAmount(makePlan(120_000))).toBe(120_000);
    });

    it('returns 0 when customAmount is 0 (sponsored child)', () => {
      const a = TariffAssignment.fromState(
        makeAssignment({ customAmount: 0, customReason: 'sponsored' }),
      );
      expect(a.effectiveAmount(makePlan(100_000))).toBe(0);
    });
  });
});
