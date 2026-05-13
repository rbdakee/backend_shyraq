import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { RefundAlreadyProcessedError } from '../errors/refund-already-processed.error';

export type RefundStatus = 'pending' | 'approved' | 'processed' | 'rejected';

export interface RefundState {
  id: string;
  kindergartenId: string;
  paymentId: string;
  invoiceId: string | null;
  amount: MoneyKzt;
  reason: string;
  status: RefundStatus;
  processedBy: string | null;
  providerRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Refund aggregate (B13). Owns the state machine
 *
 *   pending  ──approve──► approved
 *   pending  ──reject──►  rejected
 *   approved ──process──► processed
 *
 * `processed` and `rejected` are terminal. The `reason` column stores the
 * original create-time reason; if the refund is rejected, the rejection
 * note overwrites it (single column — no separate `reject_reason`).
 */
export class Refund {
  private constructor(private state: RefundState) {}

  static fromState(s: RefundState): Refund {
    return new Refund({ ...s });
  }

  toState(): RefundState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get paymentId(): string {
    return this.state.paymentId;
  }

  get invoiceId(): string | null {
    return this.state.invoiceId;
  }

  get amount(): MoneyKzt {
    return this.state.amount;
  }

  get reason(): string {
    return this.state.reason;
  }

  get status(): RefundStatus {
    return this.state.status;
  }

  get processedBy(): string | null {
    return this.state.processedBy;
  }

  get providerRef(): string | null {
    return this.state.providerRef;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── transitions ────────────────────────────────────────────────────────

  approve(processedBy: string, now: Date): void {
    if (this.state.status !== 'pending') {
      throw new RefundAlreadyProcessedError(this.state.status, 'approve');
    }
    this.state.status = 'approved';
    this.state.processedBy = processedBy;
    this.state.updatedAt = now;
  }

  reject(reason: string, now: Date): void {
    if (this.state.status !== 'pending') {
      throw new RefundAlreadyProcessedError(this.state.status, 'reject');
    }
    this.state.status = 'rejected';
    this.state.reason = reason;
    this.state.updatedAt = now;
  }

  process(providerRef: string | null, now: Date): void {
    if (this.state.status !== 'approved') {
      throw new RefundAlreadyProcessedError(this.state.status, 'process');
    }
    this.state.status = 'processed';
    this.state.providerRef = providerRef;
    this.state.updatedAt = now;
  }
}
