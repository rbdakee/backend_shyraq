import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { PaymentStatusInvalidError } from '../errors/payment-status-invalid.error';

export type PaymentProvider =
  | 'mock'
  | 'halyk_epay'
  | 'kaspi_pay'
  | 'tiptoppay'
  | 'freedom_pay'
  | 'bcc'
  | 'cash';

export type PaymentStatus =
  | 'initiated'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'refunded';

export interface PaymentState {
  id: string;
  kindergartenId: string;
  invoiceId: string;
  childId: string;
  payerUserId: string | null;
  amount: MoneyKzt;
  provider: PaymentProvider;
  providerTxnId: string | null;
  idempotencyKey: string;
  status: PaymentStatus;
  providerPayload: Record<string, unknown> | null;
  paidAt: Date | null;
  refundId: string | null;
  reconciliationAttempts?: number;
  lastReconciledAt?: Date | null;
  nextReconciliationAt?: Date | null;
  manualReviewRequiredAt?: Date | null;
  /**
   * Double-payment flags (#5b). Set when this (completed) payment is a second
   * settlement on an invoice that another guardian already paid. Optional so
   * existing `fromState` call sites (initiate, fakes) need no change; the repo
   * UPDATE (`markRefundRequired`) and the mapper populate them.
   */
  refundRequired?: boolean;
  refundReason?: string | null;
  duplicateOfPaymentId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Payment aggregate (B13). Owns the state machine
 *
 *   initiated  ──markProcessing──► processing
 *   initiated  ──markCompleted──► completed   (synchronous Mock provider)
 *   initiated  ──markFailed──► failed
 *   processing ──markCompleted──► completed
 *   processing ──markFailed──► failed
 *   completed  ──markRefunded──► refunded
 *
 * `failed` and `refunded` are terminal.
 *
 * `idempotencyKey` is enforced UNIQUE on the persistence layer; the
 * constructor only checks that the value is a non-empty string —
 * an empty key indicates a programmer error in the calling service.
 */
export class Payment {
  private constructor(private state: PaymentState) {
    if (
      typeof state.idempotencyKey !== 'string' ||
      state.idempotencyKey === ''
    ) {
      throw new Error('Payment.idempotencyKey must be a non-empty string');
    }
  }

  static fromState(s: PaymentState): Payment {
    return new Payment({ ...s });
  }

  toState(): PaymentState {
    return { ...this.state };
  }

  // ── getters ────────────────────────────────────────────────────────────

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get invoiceId(): string {
    return this.state.invoiceId;
  }

  get childId(): string {
    return this.state.childId;
  }

  get payerUserId(): string | null {
    return this.state.payerUserId;
  }

  get amount(): MoneyKzt {
    return this.state.amount;
  }

  get provider(): PaymentProvider {
    return this.state.provider;
  }

  get providerTxnId(): string | null {
    return this.state.providerTxnId;
  }

  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }

  get status(): PaymentStatus {
    return this.state.status;
  }

  get providerPayload(): Record<string, unknown> | null {
    return this.state.providerPayload;
  }

  get paidAt(): Date | null {
    return this.state.paidAt;
  }

  get refundId(): string | null {
    return this.state.refundId;
  }

  get reconciliationAttempts(): number {
    return this.state.reconciliationAttempts ?? 0;
  }

  get lastReconciledAt(): Date | null {
    return this.state.lastReconciledAt ?? null;
  }

  get nextReconciliationAt(): Date | null {
    return this.state.nextReconciliationAt ?? null;
  }

  get manualReviewRequiredAt(): Date | null {
    return this.state.manualReviewRequiredAt ?? null;
  }

  get refundRequired(): boolean {
    return this.state.refundRequired ?? false;
  }

  get refundReason(): string | null {
    return this.state.refundReason ?? null;
  }

  get duplicateOfPaymentId(): string | null {
    return this.state.duplicateOfPaymentId ?? null;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // ── predicates ─────────────────────────────────────────────────────────

  isCompleted(): boolean {
    return this.state.status === 'completed';
  }

  isTerminal(): boolean {
    return this.state.status === 'failed' || this.state.status === 'refunded';
  }

  // ── transitions ────────────────────────────────────────────────────────

  markProcessing(now: Date): void {
    if (this.state.status !== 'initiated') {
      throw new PaymentStatusInvalidError(this.state.status, 'markProcessing');
    }
    this.state.status = 'processing';
    this.state.updatedAt = now;
  }

  /**
   * Both `initiated → completed` (Mock / cash) and `processing → completed`
   * (async provider webhook) are accepted — providers vary on whether they
   * surface a separate processing phase.
   */
  markCompleted(providerTxnId: string, now: Date): void {
    if (
      this.state.status !== 'initiated' &&
      this.state.status !== 'processing'
    ) {
      throw new PaymentStatusInvalidError(this.state.status, 'markCompleted');
    }
    this.state.providerTxnId = providerTxnId;
    this.state.paidAt = now;
    this.state.status = 'completed';
    this.state.updatedAt = now;
  }

  markFailed(reason: string, now: Date): void {
    if (
      this.state.status !== 'initiated' &&
      this.state.status !== 'processing'
    ) {
      throw new PaymentStatusInvalidError(this.state.status, 'markFailed');
    }
    this.state.status = 'failed';
    this.state.providerPayload = {
      ...(this.state.providerPayload ?? {}),
      failure_reason: reason,
    };
    this.state.updatedAt = now;
  }

  markRefunded(refundId: string, now: Date): void {
    if (this.state.status !== 'completed') {
      throw new PaymentStatusInvalidError(this.state.status, 'markRefunded');
    }
    this.state.refundId = refundId;
    this.state.status = 'refunded';
    this.state.updatedAt = now;
  }
}
