import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NotificationPort } from '@/common/notifications/notification.port';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InvariantViolationError } from '@/shared-kernel/domain/errors';
import { Refund, RefundState } from './domain/entities/refund.entity';
import {
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentStatusInvalidError,
  RefundAlreadyProcessedError,
  RefundNotFoundError,
} from './domain/errors';
import { PaymentProviderPort } from './infrastructure/payment-provider/payment-provider.port';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import {
  ListRefundsFilter,
  RefundRepository,
} from './infrastructure/persistence/refund.repository';
import { InvoiceService } from './invoice.service';
import { PaymentAccountService } from './payment-account.service';

export interface CreateRefundInput {
  paymentId: string;
  amount: number;
  reason: string;
}

export interface ApproveRefundInput {
  processedBy: string;
}

export interface RejectRefundInput {
  reason: string;
}

/**
 * RefundService — orchestrates the B13 admin-driven refund flow.
 *
 *   create → pending  (admin posts a refund request)
 *   approve → approved  (admin approves; locks the row)
 *   reject  → rejected  (terminal — no provider call)
 *   process → processed (calls PaymentProviderPort.refund, atomically
 *                        flips refund + payment + invoice + debits ledger)
 *
 * Race protection: every state-flip uses conditional UPDATE WHERE
 * status=expected RETURNING * (db8cb72 / payment.service pattern). A 0-row
 * result is mapped to `RefundAlreadyProcessedError` after a follow-up
 * `findById` disambiguates between "not found" and "wrong status".
 *
 * Atomicity in `process`:
 *   - The DB writes (refund flip, payment.markRefunded, invoice.markRefunded,
 *     payment_account debit) all run inside the ambient TX provided by
 *     `TenantContextInterceptor`. If any one fails the whole TX rolls back.
 *   - The provider call is the only external side-effect. We send
 *     `idempotencyKey: 'refund:' + refund.id` so a retry after a partial
 *     failure does not double-debit at the provider — the second call
 *     returns the same `providerRefundId`.
 *   - On provider failure we leave the refund in `approved` so an operator
 *     can retry. No status flip, no DB writes — the caller surfaces a
 *     `PaymentProviderError` and the row is preserved for retry.
 *
 * B13 design decision (per plan §4.13): refunds are full-payment refunds
 * (`Refund.amount === Payment.amount`). Partial refunds are deferred to a
 * later batch — `process` flips the invoice to `refunded` and the payment
 * to `refunded` unconditionally. The `amount > 0 && amount <= payment.amount`
 * guard at create-time leaves room for a future partial-refund extension.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly refundRepo: RefundRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly invoiceService: InvoiceService,
    private readonly paymentAccountService: PaymentAccountService,
    @Inject(PaymentProviderPort)
    private readonly paymentProvider: PaymentProviderPort,
    private readonly notificationPort: NotificationPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  // ── public API ─────────────────────────────────────────────────────────

  async create(
    kindergartenId: string,
    input: CreateRefundInput,
  ): Promise<Refund> {
    const payment = await this.paymentRepo.findById(
      kindergartenId,
      input.paymentId,
    );
    if (!payment) {
      throw new PaymentNotFoundError(input.paymentId);
    }
    if (payment.status !== 'completed') {
      throw new PaymentStatusInvalidError(payment.status, 'create_refund');
    }
    const amount = round2(input.amount);
    if (!(amount > 0)) {
      throw new InvariantViolationError('refund_amount_invalid');
    }
    if (amount > round2(payment.amount)) {
      throw new InvariantViolationError('refund_amount_invalid');
    }

    const now = this.clock.now();
    const state: RefundState = {
      id: randomUUID(),
      kindergartenId,
      paymentId: payment.id,
      invoiceId: payment.invoiceId,
      amount,
      reason: input.reason,
      status: 'pending',
      processedBy: null,
      providerRef: null,
      createdAt: now,
      updatedAt: now,
    };
    const refund = Refund.fromState(state);
    return this.refundRepo.create(refund);
  }

  async approve(
    kindergartenId: string,
    refundId: string,
    input: ApproveRefundInput,
  ): Promise<Refund> {
    const now = this.clock.now();
    const updated = await this.refundRepo.markApprovedConditional(
      kindergartenId,
      refundId,
      input.processedBy,
      now,
    );
    if (!updated) {
      const existing = await this.refundRepo.findById(kindergartenId, refundId);
      if (!existing) {
        throw new RefundNotFoundError(refundId);
      }
      throw new RefundAlreadyProcessedError(existing.status, 'approve');
    }
    return updated;
  }

  async reject(
    kindergartenId: string,
    refundId: string,
    input: RejectRefundInput,
  ): Promise<Refund> {
    const now = this.clock.now();
    const updated = await this.refundRepo.markRejectedConditional(
      kindergartenId,
      refundId,
      input.reason,
      now,
    );
    if (!updated) {
      const existing = await this.refundRepo.findById(kindergartenId, refundId);
      if (!existing) {
        throw new RefundNotFoundError(refundId);
      }
      throw new RefundAlreadyProcessedError(existing.status, 'reject');
    }
    return updated;
  }

  /**
   * Drives the actual money-movement:
   *   1. Validate the refund is `approved` and the payment is still
   *      `completed`.
   *   2. Call provider.refund (external side-effect, idempotent via
   *      `refund:<id>` key). Failure → leaves refund in `approved` for
   *      retry.
   *   3. Flip refund → processed, payment → refunded, invoice → refunded,
   *      debit payment_account. All four under the ambient TX.
   *
   * Caller is expected to be inside a TenantContext-managed TX (admin HTTP
   * controller wired in T7a).
   */
  async process(kindergartenId: string, refundId: string): Promise<Refund> {
    const refund = await this.refundRepo.findById(kindergartenId, refundId);
    if (!refund) {
      throw new RefundNotFoundError(refundId);
    }
    if (refund.status !== 'approved') {
      throw new RefundAlreadyProcessedError(refund.status, 'process');
    }

    const payment = await this.paymentRepo.findById(
      kindergartenId,
      refund.paymentId,
    );
    if (!payment) {
      throw new PaymentNotFoundError(refund.paymentId);
    }
    if (payment.status !== 'completed') {
      throw new PaymentStatusInvalidError(payment.status, 'process_refund');
    }

    // External side-effect FIRST. If it throws, the refund stays `approved`
    // and the caller can retry. Sending a deterministic idempotency key
    // makes provider-side retry safe (mock returns same providerRefundId).
    let providerResult;
    try {
      providerResult = await this.paymentProvider.refund({
        providerPaymentId: payment.providerTxnId ?? payment.id,
        amountKzt: refund.amount,
        reason: refund.reason,
        idempotencyKey: `refund:${refund.id}`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'provider_failure';
      this.logger.warn(
        `refund.process: provider refund failed for refund=${refund.id} payment=${payment.id}: ${reason}`,
      );
      throw new PaymentProviderError(payment.provider, reason);
    }

    const now = this.clock.now();

    // 1. Flip refund → processed (race-safe). 0 rows = race lost (another
    //    process/reject won) → throw so the caller knows the work was not
    //    done by us.
    const processed = await this.refundRepo.markProcessedConditional(
      kindergartenId,
      refund.id,
      providerResult.providerRefundId,
      now,
    );
    if (!processed) {
      throw new RefundAlreadyProcessedError(refund.status, 'process');
    }

    // 2. Flip payment → refunded. 1:1 refund→payment in B13, so a 0-row
    //    result is unexpected; log and continue (the refund row already
    //    encodes the truth).
    const flippedPayment = await this.paymentRepo.markRefundedConditional(
      kindergartenId,
      payment.id,
      processed.id,
      now,
    );
    if (!flippedPayment) {
      this.logger.warn(
        `refund.process: payment ${payment.id} could not flip → refunded (already in non-completed state)`,
      );
    }

    // 3. Flip invoice → refunded (full-refund design — see class doc).
    const invoice = await this.invoiceService.get(
      kindergartenId,
      payment.invoiceId,
    );
    const flippedInvoice = await this.invoiceRepo.markRefundedConditional(
      kindergartenId,
      invoice.id,
      now,
    );
    if (!flippedInvoice) {
      this.logger.warn(
        `refund.process: invoice ${invoice.id} could not flip → refunded (status=${invoice.status})`,
      );
    }

    // 4. Debit the payment_account by the refund amount.
    await this.paymentAccountService.debitForRefund(
      kindergartenId,
      invoice.paymentAccountId,
      processed.amount,
    );

    // Outbox notifications — atomic with the business writes via the
    // ambient TX. `refund.processed` is the per-refund row; `payment.refunded`
    // mirrors the payment-side flip so parents see both their payment and the
    // refund as connected events. Both are gated against nannies by the
    // dispatcher (NANNY_ALLOWED_EVENT_KEYS excludes refund.* and payment.*).
    //
    // Counter-receipt OFD emission deferred to B15 (real adapter ships
    // refund-receipt support; Mock adapter has no OFD context to mirror).
    await this.notificationPort.notifyRefundProcessed({
      kindergartenId,
      refundId: processed.id,
      paymentId: payment.id,
      childId: invoice.childId,
      invoiceId: invoice.id,
      amount: processed.amount,
      processedBy: processed.processedBy ?? '',
    });
    await this.notificationPort.notifyPaymentRefunded({
      kindergartenId,
      paymentId: payment.id,
      childId: invoice.childId,
      invoiceId: invoice.id,
      amount: processed.amount,
      refundId: processed.id,
    });

    return processed;
  }

  async getById(kindergartenId: string, refundId: string): Promise<Refund> {
    const refund = await this.refundRepo.findById(kindergartenId, refundId);
    if (!refund) {
      throw new RefundNotFoundError(refundId);
    }
    return refund;
  }

  async list(
    kindergartenId: string,
    filter: ListRefundsFilter = {},
  ): Promise<Refund[]> {
    return this.refundRepo.list(kindergartenId, filter);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
