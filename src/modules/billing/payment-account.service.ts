import { Inject, Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
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
 * convention; `manager` is optional for callers running outside the HTTP
 * pipeline (cron, outbox).
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
    manager?: EntityManager,
  ): Promise<PaymentAccount> {
    return this.accounts.findOrCreateForChild(kindergartenId, childId, manager);
  }

  async creditFromPayment(
    kindergartenId: string,
    accountId: string,
    amount: MoneyKzt,
  ): Promise<PaymentAccount> {
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
