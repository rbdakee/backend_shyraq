import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { NotificationPort } from '@/common/notifications/notification.port';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TransactionRunnerPort } from '@/shared-kernel/application/ports/transaction-runner.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { KindergartenRepository } from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
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
import { BccNotConnectedError } from './domain/errors/bcc-not-connected.error';
import { FiscalReceiptPort } from './infrastructure/fiscal-receipt/fiscal-receipt.port';
import {
  VerifyWebhookInput,
  VerifyWebhookResult,
} from './infrastructure/payment-provider/payment-provider.port';
import { PaymentProviderRegistry } from './infrastructure/payment-provider/payment-provider.registry';
import { InvoiceRepository } from './infrastructure/persistence/invoice.repository';
import {
  ListPaymentsFilter,
  PaymentRepository,
} from './infrastructure/persistence/payment.repository';
import { InvoiceService } from './invoice.service';
import {
  KASPI_PAYMENT_STATUS_JOB,
  KASPI_PAYMENT_STATUS_QUEUE,
  KASPI_POLL_AGGRESSIVE_INTERVAL_MS,
  KaspiPaymentStatusJobData,
} from './kaspi-payment-status.constants';
import { PaymentAccountService } from './payment-account.service';
import { PaymentMethodAvailabilityService } from './payment-method-availability.service';

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
  /**
   * Payer phone in Kaspi format (7XXXXXXXXXX). Required when provider=kaspi_pay.
   * The controller enforces the 400 `kaspi_phone_required` guard before calling `initiate`.
   */
  kaspiPhoneNumber?: string | null;
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
    private readonly paymentProviders: PaymentProviderRegistry,
    @Inject(FiscalReceiptPort)
    private readonly fiscalReceiptPort: FiscalReceiptPort,
    private readonly notificationPort: NotificationPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
    @Inject(TransactionRunnerPort)
    private readonly tx: TransactionRunnerPort,
    // Optional so legacy spec wiring (which builds PaymentService without
    // the parent-side dependency) keeps working. `assertCanPay` fails
    // closed when missing.
    private readonly childGuardians?: ChildGuardianRepository,
    // Optional: used only to build the human-readable Kaspi payment Comment
    // (kindergarten name). When absent the Kaspi adapter falls back to the
    // invoiceId UUID. Optional so existing PaymentService specs keep compiling.
    @Optional()
    private readonly kindergartens?: KindergartenRepository,
    // K8 — optional Kaspi status-poll queue. Mirrors MonthlyBillingScheduler's
    // optional-queue pattern so the api/tests boot without Redis and the many
    // existing PaymentService specs (which omit this trailing arg) keep
    // compiling. When present, `initiate` enqueues the first poll job for a
    // kaspi_pay payment. Best-effort: a queue-down never fails the parent-pay.
    @Optional()
    @InjectQueue(KASPI_PAYMENT_STATUS_QUEUE)
    private readonly kaspiPollQueue?: Queue,
    // #5b — optional StaffMemberRepository, used ONLY to pre-resolve the kg's
    // active admins for the double-payment `payment.refund_required` outbox
    // alert. Optional so the many existing PaymentService specs (which build
    // the service without it) keep compiling; when absent the admin ping is
    // skipped (the row is still flagged + visible in the admin list).
    @Optional()
    private readonly staffRepo?: StaffMemberRepository,
    @Optional()
    private readonly paymentMethodAvailability?: PaymentMethodAvailabilityService,
  ) {}

  assertProviderEnabled(provider: PaymentProvider): void {
    this.paymentProviders.forInitiation(provider);
  }

  /**
   * Build the payer-visible payment purpose for the provider Comment. Only
   * `kaspi_pay` shows a Comment to the customer, so the kindergarten lookup is
   * skipped for every other provider. Returns undefined when the name can't be
   * resolved — the Kaspi adapter then falls back to the invoiceId UUID.
   */
  private async buildPaymentComment(
    kindergartenId: string,
    provider: PaymentProvider,
  ): Promise<string | undefined> {
    if (provider !== 'kaspi_pay' || !this.kindergartens) {
      return undefined;
    }
    const kg = await this.kindergartens.findById(kindergartenId);
    const name = kg?.name?.trim();
    return name ? `Оплата услуг детского сада «${name}»` : undefined;
  }

  /**
   * Parent-side guardian re-check used by `ParentPaymentController` before
   * initiating a payment / prepayment. The path prefix is
   * `/parent/invoices/:id/...` so `ChildAccessGuard` (which keys on
   * `:childId`) can't run, hence the explicit re-check at the service
   * boundary.
   *
   * Throws:
   *   - `ForbiddenException('not_a_guardian')` — no approved-active link
   *     to the child (covers cross-tenant attack: kg_A guardian trying to
   *     pay kg_B invoice).
   *   - `ForbiddenException('nanny_cannot_pay')` — link is a nanny;
   *     BP §4.13 forbids nanny payments end-to-end.
   *   - `ForbiddenException('secondary_pay_not_allowed')` — primary has
   *     revoked `pay_invoices` on this secondary's row.
   */
  async assertCanPay(
    kindergartenId: string,
    userId: string,
    childId: string,
  ): Promise<void> {
    if (!this.childGuardians) {
      throw new ForbiddenException('not_a_guardian');
    }
    const guardian = await this.childGuardians.findApprovedActiveByUserAndChild(
      kindergartenId,
      childId,
      userId,
    );
    if (!guardian) {
      throw new ForbiddenException('not_a_guardian');
    }
    if (guardian.role.value === 'nanny') {
      throw new ForbiddenException('nanny_cannot_pay');
    }
    // Defaults table (BP §4.13 / GuardianPermissions VO): primary + secondary
    // both default to `pay_invoices=true`, nanny → false. The VO's
    // `effective(role)` overlays per-row overrides on the role defaults so
    // primary may revoke a secondary by flipping `pay_invoices=false`.
    const effective = guardian.permissions.effective(guardian.role);
    if (effective.pay_invoices !== true) {
      throw new ForbiddenException('secondary_pay_not_allowed');
    }
  }

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

    const paymentProvider = this.paymentProviders.forInitiation(input.provider);
    if (input.provider === 'bcc') {
      if (!this.paymentMethodAvailability) {
        throw new BccNotConnectedError();
      }
      await this.paymentMethodAvailability.assertBccActive(kindergartenId);
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

    const paidSum = MoneyKzt.fromKzt(
      await this.invoiceRepo.getPaidSumForInvoice(kindergartenId, invoice.id),
    );
    const remaining = invoice.amountAfterDiscount.sub(paidSum);
    const inputAmount = MoneyKzt.fromKzt(input.amount);

    if (input.paymentMode === 'full') {
      if (!inputAmount.equals(remaining)) {
        throw new InvoiceStatusInvalidError(
          invoice.status,
          'amount_mismatch_full',
        );
      }
    } else {
      if (!inputAmount.isPositive() || inputAmount.gt(remaining)) {
        throw new InvoiceStatusInvalidError(
          invoice.status,
          'amount_mismatch_partial',
        );
      }
    }

    // Single-parent double-pay guard: recall any non-terminal kaspi_pay payment
    // THIS payer already has on THIS invoice before creating a new request, so
    // a re-initiate never leaves two live Kaspi requests on the payer's phone.
    // Different payers are intentionally NOT recalled — a genuine two-parent
    // double payment is detected + flagged (refund_required) at settlement.
    if (input.provider === 'kaspi_pay' && input.payerUserId) {
      await this.recallInFlightKaspiForPayer(
        kindergartenId,
        invoice.id,
        input.payerUserId,
      );
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
      amount: inputAmount,
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
      // Kaspi requires whole tenge; adapter rounds defensively (Math.round in
      // KaspiPaymentProvider). MoneyKzt.toNumber() quantizes to 2dp (banker's
      // rounding) so sub-tenge tiyn can appear here. The adapter's rounding is
      // the last-resort guard; no money is created or destroyed — any sub-tenge
      // fraction in an invoice is a rounding artefact from percentage discounts.
      providerResult = await paymentProvider.createPayment({
        kindergartenId,
        invoiceId: invoice.id,
        amountKzt: payment.amount.toNumber(),
        currency: 'KZT',
        returnUrl: input.returnUrl,
        payerUserId: input.payerUserId ?? undefined,
        phoneNumber: input.kaspiPhoneNumber ?? undefined,
        comment: await this.buildPaymentComment(kindergartenId, input.provider),
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
      // 'initiated' — async path (e.g. Kaspi). ALWAYS persist the provider txn
      // id (QrOperationId) so the K8 poller and refund can correlate via
      // provider_txn_id, plus any redirect/deeplink hints for an idempotent
      // retry. Without this the Kaspi operation id is lost and settlement is
      // impossible.
      const updatedNow = this.clock.now();
      await this.paymentRepo
        .markProcessingConditional(
          kindergartenId,
          payment.id,
          updatedNow,
          providerResult.providerPaymentId,
          redirectPayload,
        )
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

      // K8 — kick off the self-rescheduling Kaspi status-poll chain. Kaspi
      // sends no webhook, so this delayed-job chain is the only settlement
      // driver. Best-effort: enqueue failures (Redis down) must NOT fail the
      // parent-pay request — the payment row already carries the
      // QrOperationId, so a later manual/poll path can still settle it.
      if (input.provider === 'kaspi_pay' && this.kaspiPollQueue) {
        const jobData: KaspiPaymentStatusJobData = {
          kindergartenId,
          paymentId: payment.id,
          tick: 0,
        };
        await this.kaspiPollQueue
          .add(KASPI_PAYMENT_STATUS_JOB, jobData, {
            // tick 0 — the reschedule chain increments the tick (see processor).
            // A fixed-per-tick jobId still dedups a double-initiate of the SAME
            // payment (single-lived chain), while each reschedule stays unique.
            jobId: `kaspi-poll-${payment.id}-0`,
            attempts: 1,
            delay: KASPI_POLL_AGGRESSIVE_INTERVAL_MS,
            removeOnComplete: { count: 50 },
            removeOnFail: { count: 50 },
          })
          .catch((err) => {
            this.logger.warn(
              `payment.initiate: failed to enqueue kaspi poll for payment=${payment.id}: ${err instanceof Error ? err.message : err}`,
            );
          });
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
    const paymentProvider = this.paymentProviders.forExistingOperation(
      input.provider,
    );
    const verified = await paymentProvider.verifyWebhook(verifyInput);

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
    await this.tx.run(async (em) => {
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
   * Settlement entry-point driven by the K8 Kaspi status poller. Kaspi sends
   * no webhook, so the poller resolves the terminal outcome
   * (`remote/details → Processed | Canceled/…`) and calls this to settle.
   *
   * Mirrors `processWebhook`'s kg-scoped TX setup but the kg id + payment id
   * are already known (the poller loaded the payment cross-tenant). It REUSES
   * the same private `applyCompletedPayment` / `applyFailedPayment` helpers
   * (advisory lock per (kg, invoice) + re-read-under-lock idempotency +
   * conditional UPDATE WHERE status IN ('initiated','processing')). There is
   * NO second settlement / credit path — a duplicate poll for an already-
   * completed payment is a no-op.
   */
  async settleFromKaspiPoller(
    kindergartenId: string,
    paymentId: string,
    terminal: VerifyWebhookResult,
  ): Promise<ProcessWebhookResult> {
    await this.tx.run(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      await tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        async () => {
          if (terminal.status === 'failed') {
            await this.applyFailedPayment(kindergartenId, paymentId, terminal);
          } else {
            await this.applyCompletedPayment(
              kindergartenId,
              paymentId,
              terminal,
            );
          }
        },
      );
    });
    return { paymentId, status: terminal.status };
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
  /**
   * Single-parent double-pay guard (#5a). Recalls every still-pending
   * (`initiated`/`processing`) `kaspi_pay` payment the SAME payer already has on
   * this invoice: cancels the live Kaspi remote operation (best-effort) and
   * flips our row to `failed` ('superseded_by_new_payment'). This leaves only
   * the about-to-be-created request live, so a re-initiating parent can never
   * pay twice. Scoped to one payer — a true two-parent race is allowed through
   * and caught at settlement by the duplicate detector.
   */
  private async recallInFlightKaspiForPayer(
    kindergartenId: string,
    invoiceId: string,
    payerUserId: string,
  ): Promise<void> {
    const existing = await this.paymentRepo.findByInvoiceId(
      kindergartenId,
      invoiceId,
    );
    const now = this.clock.now();
    for (const prev of existing) {
      const inFlight =
        prev.status === 'initiated' || prev.status === 'processing';
      if (
        !inFlight ||
        prev.provider !== 'kaspi_pay' ||
        prev.payerUserId !== payerUserId
      ) {
        continue;
      }
      if (prev.providerTxnId) {
        try {
          await this.paymentProviders
            .forExistingOperation(prev.provider)
            .cancelPayment({
              kindergartenId,
              providerPaymentId: prev.providerTxnId,
            });
        } catch (err) {
          // Best-effort: the op may already be terminal, or Kaspi may be
          // unreachable. We still fail our row so the new request is the only
          // one we will settle; a stale Kaspi op expires on its own ExpireDate.
          this.logger.warn(
            `payment.initiate: kaspi recall failed for prev=${prev.id} (proceeding): ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      await this.paymentRepo
        .markFailedConditional(
          kindergartenId,
          prev.id,
          'superseded_by_new_payment',
          null,
          now,
        )
        .catch((err) => {
          this.logger.warn(
            `payment.initiate: failed to supersede prev=${prev.id}: ${err instanceof Error ? err.message : err}`,
          );
        });
    }
  }

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
    const paidSum = MoneyKzt.fromKzt(
      await this.invoiceRepo.getPaidSumForInvoice(
        kindergartenId,
        current.invoiceId,
      ),
    );
    if (paidSum.gte(invoice.amountAfterDiscount)) {
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
    } else if (
      paidSum.isPositive() &&
      (invoice.status === 'pending' || invoice.status === 'overdue')
    ) {
      // B22a T1 H14: also flip an `overdue` invoice → `partial` when a
      // sub-total payment lands. Before this fix, a payment of LESS than
      // the full remaining amount on an overdue invoice left the status
      // pinned at `overdue` forever (markPartialConditional rejected
      // `overdue` source rows), even though `partial` is the strictly
      // more-informative state. `markPartialConditional` accepts
      // {'pending','overdue'} as valid sources at the repo layer.
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

    // Double-payment detection (#5b): if ANOTHER completed payment already
    // exists on this invoice, two guardians paid the same month in parallel.
    // The invoice stays paid and we keep the credit (the money really moved),
    // but THIS later settlement is flagged for a MANUAL admin refund, pointing
    // at the first/kept payment so the admin app can link to it. The per-invoice
    // advisory lock above serialises settlements, so the earlier one is always
    // already `completed` here and only the later duplicate is flagged.
    const siblings = await this.paymentRepo.findByInvoiceId(
      kindergartenId,
      current.invoiceId,
    );
    const earlierCompleted = siblings
      .filter((p) => p.id !== updated.id && p.status === 'completed')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
    if (earlierCompleted) {
      await this.paymentRepo
        .markRefundRequired(
          kindergartenId,
          updated.id,
          'double_payment',
          earlierCompleted.id,
          now,
        )
        .catch((err) =>
          this.logger.warn(
            `payment.completed: failed to flag double payment=${updated.id} dup_of=${earlierCompleted.id}: ${err instanceof Error ? err.message : err}`,
          ),
        );
      this.logger.warn(
        `double_payment_detected: payment=${updated.id} duplicates=${earlierCompleted.id} invoice=${current.invoiceId} kg=${kindergartenId} — needs manual admin refund`,
      );
      // Best-effort admin ping so the manual-refund queue surfaces, not just a
      // flag in the payments list. Never fails settlement.
      await this.notifyDoublePayment(
        kindergartenId,
        updated,
        earlierCompleted.id,
      ).catch((err) =>
        this.logger.warn(
          `payment.completed: double-pay admin notify failed for payment=${updated.id}: ${err instanceof Error ? err.message : err}`,
        ),
      );
    }

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
        amountKzt: updated.amount.toNumber(),
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
      amount: updated.amount.toNumber(),
      provider: updated.provider,
      paidAt: updated.paidAt ?? now,
    });
    if (paidSum.gte(invoice.amountAfterDiscount)) {
      // Invoice transitioned to `paid` (full settlement). Partial payments
      // skip the invoice.paid event — the invoice is in `partial`, not paid.
      await this.notificationPort.notifyInvoicePaid({
        kindergartenId,
        invoiceId: invoice.id,
        childId: invoice.childId,
        amountAfterDiscount: invoice.amountAfterDiscount.toNumber(),
        paidAt: updated.paidAt ?? now,
      });
    }

    return updated;
  }

  /**
   * #5b admin ping — resolve the kg's active admins and emit
   * `payment.refund_required` so the manual-refund queue surfaces in the admin
   * app (not just a flag in the payments list). Skipped when the optional
   * `StaffMemberRepository` is absent (unit-test wiring) or the kg has no
   * active admins. Runs under the caller's ambient tenant context (the
   * settlement TX), so both the staff read (RLS) and the outbox insert stay
   * kg-scoped. Mirrors the poller's `notifyKaspiSessionExpired` recipient
   * resolution.
   */
  private async notifyDoublePayment(
    kindergartenId: string,
    duplicate: Payment,
    duplicateOfPaymentId: string,
  ): Promise<void> {
    if (!this.staffRepo) return;
    const admins = await this.staffRepo.listByKindergarten(kindergartenId, {
      role: 'admin',
      isActive: true,
    });
    const recipientUserIds = Array.from(
      new Set(
        admins
          .map((s) => s.toState().userId)
          .filter((u): u is string => typeof u === 'string'),
      ),
    );
    if (recipientUserIds.length === 0) return;
    await this.notificationPort.notifyPaymentRefundRequired({
      kindergartenId,
      paymentId: duplicate.id,
      duplicateOfPaymentId,
      invoiceId: duplicate.invoiceId,
      childId: duplicate.childId,
      amount: duplicate.amount.toNumber(),
      reason: 'double_payment',
      recipientUserIds,
    });
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
      amount: updated.amount.toNumber(),
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
