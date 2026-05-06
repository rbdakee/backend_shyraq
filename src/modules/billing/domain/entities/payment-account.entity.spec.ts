import { PaymentAccount, PaymentAccountState } from './payment-account.entity';

const NOW = new Date('2026-05-07T10:00:00Z');
const LATER = new Date('2026-05-07T11:00:00Z');

function makeAcct(
  overrides: Partial<PaymentAccountState> = {},
): PaymentAccount {
  return PaymentAccount.fromState({
    id: 'acct-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    childId: 'child-uuid-0001',
    balance: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('PaymentAccount domain entity', () => {
  describe('credit', () => {
    it('adds the amount to balance and stamps updatedAt', () => {
      const a = makeAcct({ balance: 1_000 });
      a.credit(500, LATER);
      expect(a.balance).toBe(1_500);
      expect(a.updatedAt).toBe(LATER);
    });

    it('rounds to two decimals', () => {
      const a = makeAcct({ balance: 0 });
      a.credit(0.1 + 0.2, LATER);
      expect(a.balance).toBe(0.3);
    });

    it('throws when amount is 0', () => {
      const a = makeAcct();
      expect(() => a.credit(0, LATER)).toThrow(/amount must be > 0/);
    });

    it('throws when amount is negative', () => {
      const a = makeAcct();
      expect(() => a.credit(-1, LATER)).toThrow(/amount must be > 0/);
    });
  });

  describe('debit', () => {
    it('subtracts the amount from balance and stamps updatedAt', () => {
      const a = makeAcct({ balance: 1_000 });
      a.debit(300, LATER);
      expect(a.balance).toBe(700);
      expect(a.updatedAt).toBe(LATER);
    });

    it('allows balance to go negative (overdue tracking)', () => {
      const a = makeAcct({ balance: 100 });
      a.debit(500, LATER);
      expect(a.balance).toBe(-400);
    });

    it('throws when amount is 0', () => {
      const a = makeAcct();
      expect(() => a.debit(0, LATER)).toThrow(/amount must be > 0/);
    });

    it('throws when amount is negative', () => {
      const a = makeAcct();
      expect(() => a.debit(-50, LATER)).toThrow(/amount must be > 0/);
    });
  });

  it('round-trips state through fromState and toState', () => {
    const state: PaymentAccountState = {
      id: 'acct-uuid-0009',
      kindergartenId: 'kg-uuid-0009',
      childId: 'child-uuid-0009',
      balance: 12_345.67,
      createdAt: NOW,
      updatedAt: LATER,
    };
    expect(PaymentAccount.fromState(state).toState()).toEqual(state);
  });
});
