import { Inject, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { PaymentAccount } from './domain/entities/payment-account.entity';
import { PaymentAccountNotFoundError } from './domain/errors/payment-account-not-found.error';
import { PaymentAccountRepository } from './infrastructure/persistence/payment-account.repository';

/**
 * PaymentAccountService — internal helper for invoice / payment / refund
 * services. Manages the per-child running-balance ledger (`payment_accounts`).
 *
 * `ensureForChild` is idempotent and race-safe — relies on the UNIQUE
 * `(kg_id, child_id)` constraint plus `INSERT ... ON CONFLICT DO NOTHING`
 * in the repo. `creditFromPayment` / `debitForRefund` mutate the domain
 * aggregate then call `save`, so any business-rule violations (e.g.
 * negative balance check beyond what the entity tolerates) are surfaced as
 * domain errors before the SQL UPDATE.
 *
 * No public controller in T7a — exposed only via the BillingModule's
 * provider list. Methods take `kindergartenId` first per service-layer
 * convention. The underlying repository falls back to
 * `tenantStorage.getStore()?.entityManager` so cron / outbox / HTTP paths
 * all participate in their ambient TX without needing an explicit handle.
 */
@Injectable()
export class PaymentAccountService {
  constructor(
    private readonly accounts: PaymentAccountRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async ensureForChild(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount> {
    return this.accounts.findOrCreateForChild(kindergartenId, childId);
  }

  async creditFromPayment(
    kindergartenId: string,
    accountId: string,
    amount: MoneyKzt,
  ): Promise<PaymentAccount> {
    // Serialise concurrent balance mutations on THIS account (per-child).
    // The per-invoice settlement lock does not cover two settlements for
    // DIFFERENT invoices of the same child landing at once — without this
    // both would read the same balance and lost-update one credit. Released
    // at the ambient TX commit; called BEFORE the read-modify-write.
    await this.accounts.acquireBalanceAdvisoryLock(kindergartenId, accountId);
    const account = await this.accounts.findById(kindergartenId, accountId);
    if (!account) {
      throw new PaymentAccountNotFoundError(accountId);
    }
    account.credit(amount, this.clock.now());
    return this.accounts.save(account);
  }

  async debitForRefund(
    kindergartenId: string,
    accountId: string,
    amount: MoneyKzt,
  ): Promise<PaymentAccount> {
    // Same hazard as creditFromPayment — serialise concurrent mutations on
    // THIS per-child account before the read-modify-write. Released at the
    // ambient TX commit.
    await this.accounts.acquireBalanceAdvisoryLock(kindergartenId, accountId);
    const account = await this.accounts.findById(kindergartenId, accountId);
    if (!account) {
      throw new PaymentAccountNotFoundError(accountId);
    }
    account.debit(amount, this.clock.now());
    return this.accounts.save(account);
  }

  async getById(
    kindergartenId: string,
    accountId: string,
  ): Promise<PaymentAccount> {
    const account = await this.accounts.findById(kindergartenId, accountId);
    if (!account) {
      throw new PaymentAccountNotFoundError(accountId);
    }
    return account;
  }

  async getByChildId(
    kindergartenId: string,
    childId: string,
  ): Promise<PaymentAccount | null> {
    return this.accounts.findByChildId(kindergartenId, childId);
  }
}
