import { roundKzt } from '@/shared-kernel/domain/money';

export interface PaymentAccountState {
  id: string;
  kindergartenId: string;
  childId: string;
  balance: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * PaymentAccount — per-child running balance ledger. One row per
 * `(kindergarten_id, child_id)` pair (UNIQUE in DB). Balances may go
 * negative — the column is signed because a partially-paid invoice plus
 * a refund can leave the account in arrears (overdue tracking).
 *
 * `credit(amount, now)` and `debit(amount, now)` both require positive
 * amounts (zero is rejected) — the direction is encoded in the method
 * name to avoid sign-flipping bugs in calling services.
 */
export class PaymentAccount {
  private constructor(private state: PaymentAccountState) {}

  static fromState(s: PaymentAccountState): PaymentAccount {
    return new PaymentAccount({ ...s });
  }

  toState(): PaymentAccountState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get childId(): string {
    return this.state.childId;
  }

  get balance(): number {
    return this.state.balance;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── methods ─────────────────────────────────────────────────────────────

  credit(amount: number, now: Date): void {
    if (!(amount > 0)) {
      throw new Error('PaymentAccount.credit: amount must be > 0');
    }
    this.state.balance = roundKzt(this.state.balance + amount);
    this.state.updatedAt = now;
  }

  debit(amount: number, now: Date): void {
    if (!(amount > 0)) {
      throw new Error('PaymentAccount.debit: amount must be > 0');
    }
    this.state.balance = roundKzt(this.state.balance - amount);
    this.state.updatedAt = now;
  }
}
