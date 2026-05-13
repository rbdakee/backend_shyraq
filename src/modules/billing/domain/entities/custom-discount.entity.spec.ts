import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { CustomDiscountAmountInvalidError } from '../errors/custom-discount-amount-invalid.error';
import { CustomDiscountConditionsInvalidError } from '../errors/custom-discount-conditions-invalid.error';
import { CustomDiscountStatusInvalidError } from '../errors/custom-discount-status-invalid.error';
import { CustomDiscountTargetInvalidError } from '../errors/custom-discount-target-invalid.error';
import { CustomDiscountValidityInvalidError } from '../errors/custom-discount-validity-invalid.error';
import {
  CustomDiscount,
  CustomDiscountState,
  CustomDiscountStatus,
} from './custom-discount.entity';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');

function makeState(
  overrides: Partial<CustomDiscountState> = {},
): CustomDiscountState {
  return {
    id: 'cd-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    name: { kk: 'Test', ru: 'Тест', en: 'Test' },
    description: null,
    discountType: 'percentage',
    amount: MoneyKzt.fromKzt(10),
    conditions: {},
    targetType: 'all',
    targetIds: null,
    validFrom: new Date('2026-05-01T00:00:00Z'),
    validUntil: new Date('2026-12-31T23:59:59.999Z'),
    maxUsesPerChild: null,
    totalMaxUses: null,
    usedCount: 0,
    priority: 100,
    stackable: false,
    notifyOnActivation: true,
    notificationTitle: null,
    notificationBody: null,
    status: 'draft',
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function make(overrides: Partial<CustomDiscountState> = {}): CustomDiscount {
  return CustomDiscount.fromState(makeState(overrides));
}

describe('CustomDiscount domain entity', () => {
  // ── invariants ─────────────────────────────────────────────────────────

  describe('invariants', () => {
    it('throws CustomDiscountAmountInvalidError when amount is zero', () => {
      expect(() => make({ amount: MoneyKzt.zero() })).toThrow(
        CustomDiscountAmountInvalidError,
      );
    });

    it('throws CustomDiscountAmountInvalidError when amount is negative', () => {
      expect(() => make({ amount: MoneyKzt.fromKzt(-5) })).toThrow(
        CustomDiscountAmountInvalidError,
      );
    });

    it('throws CustomDiscountValidityInvalidError when validUntil <= validFrom', () => {
      expect(() =>
        make({
          validFrom: new Date('2026-05-01T00:00:00Z'),
          validUntil: new Date('2026-05-01T00:00:00Z'),
        }),
      ).toThrow(CustomDiscountValidityInvalidError);
    });

    it('accepts validUntil = null (open-ended catalogue entry)', () => {
      expect(() => make({ validUntil: null })).not.toThrow();
    });

    it('throws CustomDiscountTargetInvalidError when targetType=all but targetIds provided', () => {
      expect(() => make({ targetType: 'all', targetIds: ['some-id'] })).toThrow(
        CustomDiscountTargetInvalidError,
      );
    });

    it('throws CustomDiscountTargetInvalidError when targetType=groups with empty targetIds', () => {
      expect(() => make({ targetType: 'groups', targetIds: [] })).toThrow(
        CustomDiscountTargetInvalidError,
      );
    });

    it('throws CustomDiscountTargetInvalidError when targetType=children with null targetIds', () => {
      expect(() => make({ targetType: 'children', targetIds: null })).toThrow(
        CustomDiscountTargetInvalidError,
      );
    });

    it('throws CustomDiscountTargetInvalidError on unknown targetType', () => {
      expect(() =>
        make({ targetType: 'galaxy_brain' as any, targetIds: null }),
      ).toThrow(CustomDiscountTargetInvalidError);
    });

    it('accepts targetType=age_range with null targetIds', () => {
      expect(() =>
        make({ targetType: 'age_range', targetIds: null }),
      ).not.toThrow();
    });

    it('throws CustomDiscountConditionsInvalidError on malformed conditions', () => {
      expect(() =>
        make({
          conditions: { type: 'unknown_kind', value: 1 } as any,
        }),
      ).toThrow(CustomDiscountConditionsInvalidError);
    });
  });

  // ── state machine — happy paths ────────────────────────────────────────

  describe('state machine — valid transitions', () => {
    it('activates draft → active', () => {
      const d = make({ status: 'draft' });
      d.activate(LATER);
      expect(d.status).toBe('active');
      expect(d.updatedAt).toEqual(LATER);
    });

    it('pauses active → paused', () => {
      const d = make({ status: 'active' });
      d.pause(LATER);
      expect(d.status).toBe('paused');
    });

    it('resumes paused → active', () => {
      const d = make({ status: 'paused' });
      d.resume(LATER);
      expect(d.status).toBe('active');
    });

    it('cancels from draft', () => {
      const d = make({ status: 'draft' });
      d.cancel(LATER);
      expect(d.status).toBe('cancelled');
    });

    it('cancels from active', () => {
      const d = make({ status: 'active' });
      d.cancel(LATER);
      expect(d.status).toBe('cancelled');
    });

    it('cancels from paused', () => {
      const d = make({ status: 'paused' });
      d.cancel(LATER);
      expect(d.status).toBe('cancelled');
    });

    it('marks expired from active', () => {
      const d = make({ status: 'active' });
      d.markExpired(LATER);
      expect(d.status).toBe('expired');
    });

    it('marks expired from paused', () => {
      const d = make({ status: 'paused' });
      d.markExpired(LATER);
      expect(d.status).toBe('expired');
    });
  });

  // ── state machine — invalid transitions ────────────────────────────────

  describe('state machine — invalid transitions throw', () => {
    const invalidActivateOrigins: CustomDiscountStatus[] = [
      'active',
      'paused',
      'expired',
      'cancelled',
    ];
    invalidActivateOrigins.forEach((s) => {
      it(`throws activate from ${s}`, () => {
        expect(() => make({ status: s }).activate(LATER)).toThrow(
          CustomDiscountStatusInvalidError,
        );
      });
    });

    const invalidPauseOrigins: CustomDiscountStatus[] = [
      'draft',
      'paused',
      'expired',
      'cancelled',
    ];
    invalidPauseOrigins.forEach((s) => {
      it(`throws pause from ${s}`, () => {
        expect(() => make({ status: s }).pause(LATER)).toThrow(
          CustomDiscountStatusInvalidError,
        );
      });
    });

    const invalidResumeOrigins: CustomDiscountStatus[] = [
      'draft',
      'active',
      'expired',
      'cancelled',
    ];
    invalidResumeOrigins.forEach((s) => {
      it(`throws resume from ${s}`, () => {
        expect(() => make({ status: s }).resume(LATER)).toThrow(
          CustomDiscountStatusInvalidError,
        );
      });
    });

    it('throws cancel from expired', () => {
      expect(() => make({ status: 'expired' }).cancel(LATER)).toThrow(
        CustomDiscountStatusInvalidError,
      );
    });

    it('throws cancel from cancelled', () => {
      expect(() => make({ status: 'cancelled' }).cancel(LATER)).toThrow(
        CustomDiscountStatusInvalidError,
      );
    });

    const invalidExpireOrigins: CustomDiscountStatus[] = [
      'draft',
      'expired',
      'cancelled',
    ];
    invalidExpireOrigins.forEach((s) => {
      it(`throws markExpired from ${s}`, () => {
        expect(() => make({ status: s }).markExpired(LATER)).toThrow(
          CustomDiscountStatusInvalidError,
        );
      });
    });
  });

  // ── predicates ─────────────────────────────────────────────────────────

  describe('predicates', () => {
    it('isActive=true within window when status active', () => {
      const d = make({
        status: 'active',
        validFrom: new Date('2026-04-01T00:00:00Z'),
        validUntil: new Date('2026-12-31T23:59:59Z'),
      });
      expect(d.isActive(NOW)).toBe(true);
    });

    it('isActive=false when status not active', () => {
      const d = make({
        status: 'paused',
        validFrom: new Date('2026-04-01T00:00:00Z'),
        validUntil: new Date('2026-12-31T23:59:59Z'),
      });
      expect(d.isActive(NOW)).toBe(false);
    });

    it('isActive=false when now < validFrom', () => {
      const d = make({
        status: 'active',
        validFrom: new Date('2027-01-01T00:00:00Z'),
        validUntil: null,
      });
      expect(d.isActive(NOW)).toBe(false);
    });

    it('isActive=false when now > validUntil', () => {
      const d = make({
        status: 'active',
        validFrom: new Date('2025-01-01T00:00:00Z'),
        validUntil: new Date('2025-12-31T23:59:59Z'),
      });
      expect(d.isActive(NOW)).toBe(false);
    });

    it('isActive=true when validUntil is null and active and now>=validFrom', () => {
      const d = make({
        status: 'active',
        validFrom: new Date('2025-01-01T00:00:00Z'),
        validUntil: null,
      });
      expect(d.isActive(NOW)).toBe(true);
    });

    it('isActive boundary — now === validFrom is inclusive', () => {
      const validFrom = new Date('2026-05-07T10:00:00Z');
      const d = make({
        status: 'active',
        validFrom,
        validUntil: null,
      });
      expect(d.isActive(NOW)).toBe(true);
    });

    it('isUsageLimitReached returns true when usedCount equals totalMaxUses', () => {
      const d = make({ totalMaxUses: 10, usedCount: 10 });
      expect(d.isUsageLimitReached()).toBe(true);
    });

    it('isUsageLimitReached returns false when totalMaxUses null', () => {
      const d = make({ totalMaxUses: null, usedCount: 9999 });
      expect(d.isUsageLimitReached()).toBe(false);
    });

    it('isExpiredByDate returns true when now > validUntil', () => {
      const d = make({
        validFrom: new Date('2024-01-01T00:00:00Z'),
        validUntil: new Date('2025-01-01T00:00:00Z'),
      });
      expect(d.isExpiredByDate(NOW)).toBe(true);
    });

    it('isExpiredByDate returns false when validUntil is null', () => {
      const d = make({ validUntil: null });
      expect(d.isExpiredByDate(NOW)).toBe(false);
    });

    it('isTerminal returns true for expired and cancelled', () => {
      expect(make({ status: 'expired' }).isTerminal()).toBe(true);
      expect(make({ status: 'cancelled' }).isTerminal()).toBe(true);
      expect(make({ status: 'active' }).isTerminal()).toBe(false);
    });
  });

  // ── fromState / toState roundtrip ──────────────────────────────────────

  describe('fromState/toState', () => {
    it('roundtrips state through fromState/toState', () => {
      const s = makeState({ status: 'active' });
      const d = CustomDiscount.fromState(s);
      const out = d.toState();
      expect(out).toEqual(s);
    });

    it('toState returns a copy (not a live reference)', () => {
      const d = make();
      const a = d.toState();
      a.status = 'cancelled';
      expect(d.status).toBe('draft');
    });
  });
});
