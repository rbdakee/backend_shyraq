import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { PaymentAccount } from './domain/entities/payment-account.entity';
import { PaymentAccountNotFoundError } from './domain/errors/payment-account-not-found.error';
import { PaymentAccountRepository } from './infrastructure/persistence/payment-account.repository';
import { PaymentAccountService } from './payment-account.service';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NOW = new Date('2026-05-04T09:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakePaymentAccountRepo extends PaymentAccountRepository {
  rows = new Map<string, PaymentAccount>();
  private nextId = 0;

  put(account: PaymentAccount): void {
    this.rows.set(account.id, account);
  }

  findOrCreateForChild(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount> {
    for (const a of this.rows.values()) {
      if (a.kindergartenId === kindergartenId && a.childId === childId) {
        return Promise.resolve(a);
      }
    }
    const id = `pa-${++this.nextId}`;
    const a = PaymentAccount.fromState({
      id,
      kindergartenId,
      childId,
      balance: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    this.rows.set(id, a);
    return Promise.resolve(a);
  }

  findById(kindergartenId: string, id: string): Promise<PaymentAccount | null> {
    const a = this.rows.get(id);
    if (!a || a.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(a);
  }

  findByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount | null> {
    for (const a of this.rows.values()) {
      if (a.kindergartenId === kindergartenId && a.childId === childId) {
        return Promise.resolve(a);
      }
    }
    return Promise.resolve(null);
  }

  save(account: PaymentAccount): Promise<PaymentAccount> {
    this.rows.set(account.id, account);
    return Promise.resolve(account);
  }
}

describe('PaymentAccountService', () => {
  let repo: FakePaymentAccountRepo;
  let svc: PaymentAccountService;

  beforeEach(() => {
    repo = new FakePaymentAccountRepo();
    svc = new PaymentAccountService(repo, new FakeClock(NOW));
  });

  describe('ensureForChild', () => {
    it('creates an account on first call', async () => {
      const a = await svc.ensureForChild(KG, CHILD);
      expect(a.kindergartenId).toBe(KG);
      expect(a.childId).toBe(CHILD);
      expect(a.balance).toBe(0);
    });

    it('returns the same account on second call', async () => {
      const first = await svc.ensureForChild(KG, CHILD);
      const second = await svc.ensureForChild(KG, CHILD);
      expect(second.id).toBe(first.id);
    });
  });

  describe('creditFromPayment / debitForRefund', () => {
    it('credits the balance', async () => {
      const a = await svc.ensureForChild(KG, CHILD);
      const updated = await svc.creditFromPayment(KG, a.id, 5000);
      expect(updated.balance).toBe(5000);
    });

    it('debits the balance', async () => {
      const a = await svc.ensureForChild(KG, CHILD);
      await svc.creditFromPayment(KG, a.id, 5000);
      const updated = await svc.debitForRefund(KG, a.id, 1500);
      expect(updated.balance).toBe(3500);
    });

    it('rejects credit of zero / negative amount via domain invariant', async () => {
      const a = await svc.ensureForChild(KG, CHILD);
      await expect(svc.creditFromPayment(KG, a.id, 0)).rejects.toThrow(
        /amount must be > 0/,
      );
    });

    it('throws PaymentAccountNotFoundError for unknown account', async () => {
      await expect(svc.creditFromPayment(KG, 'missing', 100)).rejects.toThrow(
        PaymentAccountNotFoundError,
      );
    });

    it('throws PaymentAccountNotFoundError on cross-tenant id', async () => {
      const a = await svc.ensureForChild(KG, CHILD);
      await expect(
        svc.creditFromPayment(
          '22222222-2222-2222-2222-222222222222',
          a.id,
          100,
        ),
      ).rejects.toThrow(PaymentAccountNotFoundError);
    });
  });

  describe('getById / getByChildId', () => {
    it('getById returns the account', async () => {
      const a = await svc.ensureForChild(KG, CHILD);
      const fetched = await svc.getById(KG, a.id);
      expect(fetched.id).toBe(a.id);
    });

    it('getById throws PaymentAccountNotFoundError for unknown', async () => {
      await expect(svc.getById(KG, 'missing')).rejects.toThrow(
        PaymentAccountNotFoundError,
      );
    });

    it('getByChildId returns null when child has no account', async () => {
      const a = await svc.getByChildId(KG, CHILD);
      expect(a).toBeNull();
    });

    it('getByChildId returns the account when present', async () => {
      await svc.ensureForChild(KG, CHILD);
      const a = await svc.getByChildId(KG, CHILD);
      expect(a).not.toBeNull();
    });
  });
});
