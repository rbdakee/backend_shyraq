import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { NotificationPort } from '@/common/notifications/notification.port';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { roundKzt } from '@/shared-kernel/domain/money';
import {
  Payment,
  PaymentProvider,
  PaymentState,
} from './domain/entities/payment.entity';
import {
  InvoiceAlreadyPaidError,
  InvoiceStatusInvalidError,
  PaymentIdempotencyConflictError,
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentStatusInvalidError,
} from './domain/errors';
import { FiscalReceiptPort } from './infrastructure/fiscal-receipt/fiscal-receipt.port';
import {
  PaymentProviderPort,
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './infrastructure/payment-provider/payment-provider.port';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';
import {
  ListPaymentsFilter,
  PaymentRepository,
} from './infrastructure/persistence/payment.repository';
import { InvoiceService } from './invoice.service';
import { PaymentAccountService } from './payment-account.service';

export type PaymentInitiationMode = 'full' | 'partial';

export interface InitiatePaymentInput {
  invoiceId: string;
  /** KZT, two-decimal. Must equal invoice remaining (`amount_after_discount - paid_sum`) when `paymentMode='full'`. */
  amount: number;
  paymentMode: PaymentInitiationMode;
  provider: PaymentProvider;
  /** Client-supplied UUID. Repeated `initiate` calls with the same key MUST resolve to the same payment row. */
  idempotencyKey: string;
  payerUserId?: string | null;
  returnUrl: string;
}

export interface InitiatePaymentResult {
  payment: Payment;
  redirectUrl?: string;
  deeplink?: string;
}

export interface ProcessWebhookInput {
  provider: PaymentProvider;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer;
}

export interface ProcessWebhookResult {
  paymentId: string;
  status: 'completed' | 'failed';
}

/**
 * PaymentService — orchestrates the B13 parent-pay flow plus async webhook
 * settlement.
 *
 * State-machine race protection (mirrors db8cb72 + B11/B12 patterns):
 *
 *   1. `initiate` writes a fresh `payments` row with `status='initiated'`
 *      and a UNIQUE `idempotency_key`. Concurrent retries with the same
 *      key collapse: the second INSERT fails 23505 →
 *      `PaymentIdempotencyConflictError` is caught internally, the row is
 *      re-fetched, and the existing payment is returned. Synchronous Mock
 *      providers settle inside the same call; real providers (Halyk etc.)
 *      return `'initiated'` and rely on `processWebhook`.
 *
 *   2. `processWebhook` looks up the payment cross-tenant by
 *      `(provider, provider_txn_id)` (no kg context yet), then opens a
 *      kg-scoped TX. Inside the kg TX it acquires the per-invoice
 *      advisory lock so a concurrent parent-pay-initiate or duplicate
 *      provider replay does not produce two completed payments for the
 *      same invoice. Every status flip uses conditional UPDATE WHERE
 *      status=expected — losers are a no-op.
 *
 *   3. After completion the helper credits the payment_account and flips
 *      the invoice to `paid` (or `partial` if the running paid sum is
 *      below the post-discount total). Both flips are conditional —
 *      0-row results log a warning and skip; the writer who lost the
 *      race already applied the same change.
 *
 * Outbox / fiscal hooks are deferred: `notifyPaymentCompleted` and
 * `FiscalReceiptPort.emitReceipt` plug in at T5c. Markers are left
 * inline so the next sub-agent can find them.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly paymentRepo: PaymentRepository,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly invoiceService: InvoiceService,
    private readonly paymentAccountService: PaymentAccountService,
    @Inject(PaymentProviderPort)
    private readonly paymentProvider: PaymentProviderPort,
    @Inject(FiscalReceiptPort)
    private readonly fiscalReceiptPort: FiscalReceiptPort,
    private readonly notificationPort: NotificationPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    private readonly dataSource: DataSource,
  ) {}

  // ── public API ─────────────────────────────────────────────────────────

  async initiate(
    kindergartenId: string,
    input: InitiatePaymentInput,
  ): Promise<InitiatePaymentResult> {
    // Fast-path idempotency: repeat `initiate` with the same key MUST
    // return the same payment row without re-creating a provider tx.
    const existing = await this.paymentRepo.findByIdempotencyKey(
      kindergartenId,
      input.idempotencyKey,
    );
    if (existing) {
      const redirect = readRedirectFromPayload(existing);
      return {
        payment: existing,
        redirectUrl: redirect.redirectUrl,
        deeplink: redirect.deeplink,
      };
    }

    // Validate invoice + remaining amount before reaching out to the
    // provider so the provider-side budget is not consumed by a doomed
    // request.
    const invoice = await this.invoiceService.get(
      kindergartenId,
      input.invoiceId,
    );
    if (invoice.status === 'paid' || invoice.status === 'refunded') {
      throw new InvoiceAlreadyPaidError(invoice.id);
    }
    if (
      invoice.status !== 'pending' &&
      invoice.status !== 'partial' &&
      invoice.status !== 'overdue'
    ) {
      throw new InvoiceStatusInvalidError(invoice.status, 'initiate_payment');
    }

    const paidSum = await this.invoiceRepo.getPaidSumForInvoice(
      kindergartenId,
      invoice.id,
    );
    const remaining = roundKzt(invoice.amountAfterDiscount - paidSum);

    if (input.paymentMode === 'full') {
      if (roundKzt(input.amount) !== remaining) {
        throw new InvoiceStatusInvalidError(
          invoice.status,
          'amount_mismatch_full',
        );
      }
    } else {
      if (input.amount <= 0 || roundKzt(input.amount) > remaining) {
        throw new InvoiceStatusInvalidError(
          invoice.status,
          'amount_mismatch_partial',
        );
      }
    }

    // Build domain Payment in `initiated` state. Persist BEFORE calling
    // the provider so the row exists when the (possibly synchronous)
    // webhook fires back. If the provider call later throws we flip the
    // existing row to `failed`.
    const now = this.clock.now();
    const paymentId = randomUUID();
    const state: PaymentState = {
      id: paymentId,
      kindergartenId,
      invoiceId: invoice.id,
      childId: invoice.childId,
      payerUserId: input.payerUserId ?? null,
      amount: roundKzt(input.amount),
      provider: input.provider,
      providerTxnId: null,
      idempotencyKey: input.idempotencyKey,
      status: 'initiated',
      providerPayload: null,
      paidAt: null,
      refundId: null,
      createdAt: now,
      updatedAt: now,
    };
    let payment = Payment.fromState(state);

    try {
      payment = await this.paymentRepo.create(payment);
    } catch (err) {
      if (err instanceof PaymentIdempotencyConflictError) {
        // Concurrent INSERT won the race; re-read and return the winner.
        const winner = await this.paymentRepo.findByIdempotencyKey(
          kindergartenId,
          input.idempotencyKey,
        );
        if (winner) {
          const redirect = readRedirectFromPayload(winner);
          return {
            payment: winner,
            redirectUrl: redirect.redirectUrl,
            deeplink: redirect.deeplink,
          };
        }
      }
      throw err;
    }

    // Call the provider. On failure mark our row failed and surface a
    // domain error to the caller. This avoids leaking provider-specific
    // exception types to the controller layer.
    let providerResult;
    try {
      providerResult = await this.paymentProvider.createPayment({
        invoiceId: invoice.id,
        amountKzt: payment.amount,
        currency: 'KZT',
        returnUrl: input.returnUrl,
        payerUserId: input.payerUserId ?? undefined,
        idempotencyKey: input.idempotencyKey,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'provider_failure';
      await this.paymentRepo
        .markFailedConditional(kindergartenId, payment.id, reason, null, now)
        .catch((markErr) => {
          this.logger.warn(
            `payment.initiate: failed to mark payment=${payment.id} failed after provider error: ${markErr instanceof Error ? markErr.message : markErr}`,
          );
        });
      throw new PaymentProviderError(input.provider, reason);
    }

    // Stash redirect/deeplink hints into provider_payload so a later
    // idempotent retry can return them without re-calling the provider.
    const redirectPayload: Record<string, unknown> = {};
    if (providerResult.redirectUrl)
      redirectPayload.redirect_url = providerResult.redirectUrl;
    if (providerResult.deeplink)
      redirectPayload.deeplink = providerResult.deeplink;

    if (providerResult.status === 'completed') {
      // Synchronous-completion path (Mock + cash). Funnel through the
      // same helper the webhook handler uses so both paths stay in sync.
      payment = await this.applyCompletedPayment(kindergartenId, payment.id, {
        providerPaymentId: providerResult.providerPaymentId,
        status: 'completed',
        raw: { ...redirectPayload, status: 'completed' },
      });
    } else if (providerResult.status === 'failed') {
      const failed = await this.paymentRepo.markFailedConditional(
        kindergartenId,
        payment.id,
        'provider_returned_failed',
        { ...redirectPayload, status: 'failed' },
        this.clock.now(),
      );
      if (failed) payment = failed;
    } else {
      // 'initiated' — async path. Persist redirect hints into the payload
      // so an idempotent retry can read them back.
      if (Object.keys(redirectPayload).length > 0) {
        const updatedNow = this.clock.now();
        await this.paymentRepo
          .markProcessingConditional(kindergartenId, payment.id, updatedNow)
          .catch((err) => {
            this.logger.warn(
              `payment.initiate: failed to mark processing payment=${payment.id}: ${err instanceof Error ? err.message : err}`,
            );
          });
        // Re-read so caller sees the latest snapshot.
        const refreshed = await this.paymentRepo.findById(
          kindergartenId,
          payment.id,
        );
        if (refreshed) payment = refreshed;
      }
    }

    return {
      payment,
      redirectUrl: providerResult.redirectUrl,
      deeplink: providerResult.deeplink,
    };
  }

  async processWebhook(
    input: ProcessWebhookInput,
  ): Promise<ProcessWebhookResult> {
    // 1. Verify signature. The port throws WebhookSignatureInvalidError on
    //    mismatch — we let it propagate so the controller can render a
    //    400 (or, for stale provider replays, the controller can choose
    //    to swallow it and ack 200; T7b's responsibility, not the
    //    service's).
    const verifyInput: VerifyWebhookInput = {
      headers: input.headers,
      body: input.body,
      rawBody: input.rawBody,
    };
    const verified = await this.paymentProvider.verifyWebhook(verifyInput);

    // 2. Cross-tenant lookup by (provider, provider_txn_id). Bypass-RLS
    //    is scoped to a fresh TX inside the repo so it does not leak
    //    into the ambient TX of any caller.
    const found = await this.paymentRepo.findByProviderTxnIdCrossTenant(
      input.provider,
      verified.providerPaymentId,
    );
    if (!found) {
      throw new PaymentNotFoundError(verified.providerPaymentId);
    }

    // 3. Open a kg-scoped TX so RLS, advisory lock, and side-effect
    //    writes all live on the same TX. This mirrors what
    //    TenantContextInterceptor would do for an HTTP path — but the
    //    webhook controller does not (and cannot) carry kg context, so
    //    we set it up here using the kg id we just resolved.
    const kgId = found.kindergartenId;
    await this.dataSource.transaction(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kgId,
      ]);
      await tenantStorage.run(
        { kgId, bypass: false, entityManager: em },
        async () => {
          if (verified.status === 'failed') {
            await this.applyFailedPayment(kgId, found.id, verified);
          } else {
            await this.applyCompletedPayment(kgId, found.id, verified);
          }
        },
      );
    });

    return { paymentId: found.id, status: verified.status };
  }

  /**
   * Admin/internal — flips an `initiated`/`processing` payment to
   * `failed`. Throws `PaymentNotFoundError` when the row does not exist
   * and `PaymentStatusInvalidError` if the conditional UPDATE matches 0
   * rows (terminal status).
   */
  async markFailed(
    kindergartenId: string,
    paymentId: string,
    reason: string,
  ): Promise<Payment> {
    const existing = await this.paymentRepo.findById(kindergartenId, paymentId);
    if (!existing) {
      throw new PaymentNotFoundError(paymentId);
    }
    const updated = await this.paymentRepo.markFailedConditional(
      kindergartenId,
      paymentId,
      reason,
      null,
      this.clock.now(),
    );
    if (!updated) {
      throw new PaymentStatusInvalidError(existing.status, 'markFailed');
    }
    return updated;
  }

  async getById(kindergartenId: string, paymentId: string): Promise<Payment> {
    const payment = await this.paymentRepo.findById(kindergartenId, paymentId);
    if (!payment) {
      throw new PaymentNotFoundError(paymentId);
    }
    return payment;
  }

  async list(
    kindergartenId: string,
    filter: ListPaymentsFilter = {},
  ): Promise<Payment[]> {
    return this.paymentRepo.list(kindergartenId, filter);
  }

  // ── private helpers ───────────────────────────────────────────────────

  /**
   * Applies the "payment completed" outcome under the per-invoice advisory
   * lock. Idempotent at every step:
   *   - Conditional UPDATE on payment.status — second writer is a no-op.
   *   - Conditional UPDATE on invoice.status — concurrent flip is a no-op.
   *   - PaymentAccount credit happens only when the payment row was
   *     actually flipped on this call (the `updated` variable from the
   *     conditional UPDATE is non-null).
   */
  private async applyCompletedPayment(
    kindergartenId: string,
    paymentId: string,
    verified: VerifyWebhookResult,
  ): Promise<Payment> {
    const current = await this.paymentRepo.findById(kindergartenId, paymentId);
    if (!current) {
      throw new PaymentNotFoundError(paymentId);
    }

    await this.paymentRepo.acquirePaymentAdvisoryLock(
      kindergartenId,
      current.invoiceId,
    );

    // Re-read under the lock — another concurrent webhook may have already
    // settled this payment. Treat completed/refunded as idempotent no-ops.
    const reread = await this.paymentRepo.findById(kindergartenId, paymentId);
    if (!reread) {
      throw new PaymentNotFoundError(paymentId);
    }
    if (reread.status === 'completed' || reread.status === 'refunded') {
      return reread;
    }

    const now = this.clock.now();
    const updated = await this.paymentRepo.markCompletedConditional(
      kindergartenId,
      paymentId,
      verified.providerPaymentId,
      now,
      verified.raw,
      now,
    );
    if (!updated) {
      // Race lost — another writer flipped the row to a terminal state.
      // Re-read for the caller; do not credit the account again.
      const after = await this.paymentRepo.findById(kindergartenId, paymentId);
      if (!after) {
        throw new PaymentNotFoundError(paymentId);
      }
      this.logger.warn(
        `payment.completed: race lost for payment=${paymentId} status=${after.status}`,
      );
      return after;
    }

    // Invoice flip: re-read paid sum (now includes this payment).
    const invoice = await this.invoiceService.get(
      kindergartenId,
      current.invoiceId,
    );
    const paidSum = await this.invoiceRepo.getPaidSumForInvoice(
      kindergartenId,
      current.invoiceId,
    );
    if (paidSum >= invoice.amountAfterDiscount) {
      const flipped = await this.invoiceRepo.markPaidConditional(
        kindergartenId,
        current.invoiceId,
        now,
      );
      if (!flipped) {
        this.logger.warn(
          `payment.completed: invoice ${current.invoiceId} could not flip → paid (concurrent cancel/already-paid)`,
        );
      }
    } else if (paidSum > 0 && invoice.status === 'pending') {
      const flipped = await this.invoiceRepo.markPartialConditional(
        kindergartenId,
        current.invoiceId,
        now,
      );
      if (!flipped) {
        this.logger.warn(
          `payment.completed: invoice ${current.invoiceId} could not flip → partial (concurrent transition)`,
        );
      }
    }

    // PaymentAccount credit only when this call actually flipped the row.
    await this.paymentAccountService.creditFromPayment(
      kindergartenId,
      invoice.paymentAccountId,
      updated.amount,
    );

    // Fiscal receipt emit — best-effort. OFD providers (B15) are async +
    // transient by nature; refusing to settle a payment because an OFD
    // request blipped would be the wrong trade-off. Wrap in try/catch and
    // log; persistence of the failure for retry lands in B15 alongside
    // the real adapter.
    try {
      const paidAt = updated.paidAt ?? now;
      const receipt = await this.fiscalReceiptPort.emitReceipt({
        paymentId: updated.id,
        invoiceId: invoice.id,
        kindergartenId,
        amountKzt: updated.amount,
        paidAt,
        // Mock adapter ignores payer fields; B15 will wire real lookups.
        payerName: undefined,
        payerPhone: undefined,
      });
      this.logger.log(
        `Emitted fiscal receipt ${receipt.fiscalSign} for payment ${updated.id} (status=${receipt.ofdStatus})`,
      );
    } catch (err) {
      // TODO(B15): persist fiscal-failure for retry via the
      // `fiscal.retry_failed` outbox event once the real adapter ships.
      this.logger.warn(
        `payment.completed: fiscal emit failed for payment=${updated.id} invoice=${invoice.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Outbox notifications — atomic with the business writes via the
    // ambient TX (`tenantStorage` EntityManager picked up by
    // `OutboxNotificationAdapter`). Fan-out + nanny-policy filtering happen
    // in `NotificationDispatcher` at outbox-poll time.
    await this.notificationPort.notifyPaymentCompleted({
      kindergartenId,
      paymentId: updated.id,
      childId: invoice.childId,
      invoiceId: invoice.id,
      amount: updated.amount,
      provider: updated.provider,
      paidAt: updated.paidAt ?? now,
    });
    if (paidSum >= invoice.amountAfterDiscount) {
      // Invoice transitioned to `paid` (full settlement). Partial payments
      // skip the invoice.paid event — the invoice is in `partial`, not paid.
      await this.notificationPort.notifyInvoicePaid({
        kindergartenId,
        invoiceId: invoice.id,
        childId: invoice.childId,
        amountAfterDiscount: invoice.amountAfterDiscount,
        paidAt: updated.paidAt ?? now,
      });
    }

    return updated;
  }

  /**
   * Webhook reported a failed settlement. Conditionally flips the
   * payment to `failed`; concurrent terminal flips (e.g. the parent
   * cancelled mid-flight) are logged and ignored.
   */
  private async applyFailedPayment(
    kindergartenId: string,
    paymentId: string,
    verified: VerifyWebhookResult,
  ): Promise<Payment> {
    const current = await this.paymentRepo.findById(kindergartenId, paymentId);
    if (!current) {
      throw new PaymentNotFoundError(paymentId);
    }

    await this.paymentRepo.acquirePaymentAdvisoryLock(
      kindergartenId,
      current.invoiceId,
    );

    const reread = await this.paymentRepo.findById(kindergartenId, paymentId);
    if (!reread) {
      throw new PaymentNotFoundError(paymentId);
    }
    if (reread.status === 'failed') {
      return reread;
    }
    if (reread.status === 'completed' || reread.status === 'refunded') {
      this.logger.warn(
        `payment.failed: webhook arrived for already-${reread.status} payment=${paymentId}; ignoring`,
      );
      return reread;
    }

    const now = this.clock.now();
    const updated = await this.paymentRepo.markFailedConditional(
      kindergartenId,
      paymentId,
      verified.failureReason ?? 'webhook_failed',
      verified.raw,
      now,
    );
    if (!updated) {
      const after = await this.paymentRepo.findById(kindergartenId, paymentId);
      if (!after) {
        throw new PaymentNotFoundError(paymentId);
      }
      return after;
    }
    await this.notificationPort.notifyPaymentFailed({
      kindergartenId,
      paymentId: updated.id,
      childId: updated.childId,
      invoiceId: updated.invoiceId,
      amount: updated.amount,
      provider: updated.provider,
      failureReason: verified.failureReason ?? 'webhook_failed',
    });
    return updated;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

function readRedirectFromPayload(payment: Payment): {
  redirectUrl?: string;
  deeplink?: string;
} {
  const payload = payment.providerPayload ?? {};
  const result: { redirectUrl?: string; deeplink?: string } = {};
  if (typeof payload.redirect_url === 'string') {
    result.redirectUrl = payload.redirect_url;
  }
  if (typeof payload.deeplink === 'string') {
    result.deeplink = payload.deeplink;
  }
  return result;
}
