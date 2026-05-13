import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { PaymentAccount, PaymentAccountState } from './payment-account.entity';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');

const m = (n: number): MoneyKzt => MoneyKzt.fromKzt(n);

function makeAcct(
  overrides: Partial<PaymentAccountState> = {},
): PaymentAccount {
  return PaymentAccount.fromState({
    id: 'acct-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    childId: 'child-uuid-0001',
    balance: MoneyKzt.zero(),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('PaymentAccount domain entity', () => {
  describe('credit', () => {
    it('adds the amount to balance and stamps updatedAt', () => {
      const a = makeAcct({ balance: m(1_000) });
      a.credit(m(500), LATER);
      expect(a.balance.toNumber()).toBe(1_500);
      expect(a.updatedAt).toBe(LATER);
    });

    it('rounds to two decimals', () => {
      const a = makeAcct({ balance: MoneyKzt.zero() });
      a.credit(m(0.1 + 0.2), LATER);
      expect(a.balance.toNumber()).toBe(0.3);
    });

    it('throws when amount is 0', () => {
      const a = makeAcct();
      expect(() => a.credit(MoneyKzt.zero(), LATER)).toThrow(
        /amount must be > 0/,
      );
    });

    it('throws when amount is negative', () => {
      const a = makeAcct();
      expect(() => a.credit(m(-1), LATER)).toThrow(/amount must be > 0/);
    });
  });

  describe('debit', () => {
    it('subtracts the amount from balance and stamps updatedAt', () => {
      const a = makeAcct({ balance: m(1_000) });
      a.debit(m(300), LATER);
      expect(a.balance.toNumber()).toBe(700);
      expect(a.updatedAt).toBe(LATER);
    });

    it('allows balance to go negative (overdue tracking)', () => {
      const a = makeAcct({ balance: m(100) });
      a.debit(m(500), LATER);
      expect(a.balance.toNumber()).toBe(-400);
    });

    it('throws when amount is 0', () => {
      const a = makeAcct();
      expect(() => a.debit(MoneyKzt.zero(), LATER)).toThrow(
        /amount must be > 0/,
      );
    });

    it('throws when amount is negative', () => {
      const a = makeAcct();
      expect(() => a.debit(m(-50), LATER)).toThrow(/amount must be > 0/);
    });
  });

  it('round-trips state through fromState and toState', () => {
    const state: PaymentAccountState = {
      id: 'acct-uuid-0009',
      kindergartenId: 'kg-uuid-0009',
      childId: 'child-uuid-0009',
      balance: m(12_345.67),
      createdAt: NOW,
      updatedAt: LATER,
    };
    expect(PaymentAccount.fromState(state).toState()).toEqual(state);
  });
});
