import { Inject, Injectable, Logger } from '@nestjs/common';
import { NotificationPort } from '@/common/notifications/notification.port';
import { tenantStorage } from '@/database/tenant-storage';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TransactionRunnerPort } from '@/shared-kernel/application/ports/transaction-runner.port';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { VerifyWebhookResult } from './infrastructure/payment-provider/payment-provider.port';
import { KaspiPaymentProvider } from './infrastructure/payment-provider/kaspi/kaspi-payment-provider.adapter';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { KaspiMerchantSessionRepository } from './infrastructure/persistence/kaspi-merchant-session.repository';
import { KaspiConnectService } from './kaspi-connect.service';
import { KASPI_POLL_HARD_CAP_MS } from './kaspi-payment-status.constants';
import { PaymentService } from './payment.service';

export type KaspiPollOutcome = 'settled' | 'failed' | 'reschedule' | 'stop';

export interface KaspiPollResult {
  outcome: KaspiPollOutcome;
  /** Payment `created_at` — drives the processor's adaptive next-delay. */
  paymentCreatedAt: Date | null;
  /** ExpireDate from remote/details when known (informational for the chain). */
  expireDate: Date | null;
}

/**
 * KaspiPaymentStatusPollerService — thin orchestration for ONE poll tick of a
 * single payment. No BullMQ types here (the processor owns scheduling); this
 * service decides the OUTCOME of a tick and performs any settlement /
 * refresh / notify side-effect.
 *
 * Cross-tenant correctness: the payment is loaded via
 * `paymentRepo.findByIdCrossTenant` (own bypass-RLS TX), the Kaspi HTTP call
 * runs with NO DB transaction open, and every kg-scoped write (settlement,
 * admin-notify) opens its OWN kg-scoped TX. The bypass GUC never leaks.
 *
 * Settlement REUSES `PaymentService.settleFromKaspiPoller` → the existing
 * `applyCompletedPayment` / `applyFailedPayment` advisory-lock + conditional-
 * UPDATE idempotency. No second credit path.
 */
@Injectable()
export class KaspiPaymentStatusPollerService {
  private readonly logger = new Logger(KaspiPaymentStatusPollerService.name);

  constructor(
    private readonly kaspiProvider: KaspiPaymentProvider,
    private readonly paymentService: PaymentService,
    private readonly paymentRepo: PaymentRepository,
    private readonly kaspiConnect: KaspiConnectService,
    private readonly sessions: KaspiMerchantSessionRepository,
    private readonly staffRepo: StaffMemberRepository,
    private readonly notificationPort: NotificationPort,
    @Inject(TransactionRunnerPort)
    private readonly tx: TransactionRunnerPort,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async pollOnce(
    kindergartenId: string,
    paymentId: string,
  ): Promise<KaspiPollResult> {
    const payment = await this.paymentRepo.findByIdCrossTenant(
      kindergartenId,
      paymentId,
    );
    if (!payment) {
      // Row gone (e.g. tenant archived / hard-deleted) — stop the chain.
      return { outcome: 'stop', paymentCreatedAt: null, expireDate: null };
    }

    const createdAt = payment.createdAt;

    // Only kaspi_pay payments that are still in-flight are pollable.
    if (
      payment.provider !== 'kaspi_pay' ||
      (payment.status !== 'initiated' && payment.status !== 'processing')
    ) {
      return { outcome: 'stop', paymentCreatedAt: createdAt, expireDate: null };
    }

    const providerTxnId = payment.providerTxnId;
    if (!providerTxnId) {
      // QrOperationId not persisted yet — rare race between initiate's
      // markProcessing persist and the first poll tick. Let it retry.
      this.logger.warn(
        `kaspi-poll: payment=${paymentId} has no provider_txn_id yet; rescheduling`,
      );
      return {
        outcome: 'reschedule',
        paymentCreatedAt: createdAt,
        expireDate: null,
      };
    }

    const now = this.clock.now();

    // Hard-cap fallback: a payment older than HARD_CAP_MS is failed regardless
    // of what Kaspi says (defends against a never-terminating poll chain when
    // ExpireDate is absent from remote/details).
    if (now.getTime() - createdAt.getTime() >= KASPI_POLL_HARD_CAP_MS) {
      this.warnForceFail(paymentId, kindergartenId, 'hard_cap', null);
      await this.paymentService.settleFromKaspiPoller(
        kindergartenId,
        paymentId,
        this.failedTerminal(providerTxnId, 'kaspi_expired_hard_cap', {
          reason: 'hard_cap',
        }),
      );
      return {
        outcome: 'failed',
        paymentCreatedAt: createdAt,
        expireDate: null,
      };
    }

    // Kaspi HTTP call — NO DB transaction open here. Network / not-connected
    // errors are non-fatal: log (no secrets) and reschedule.
    let details;
    try {
      details = await this.kaspiProvider.getPaymentStatus({
        kindergartenId,
        providerPaymentId: providerTxnId,
      });
    } catch (err) {
      this.logger.warn(
        `kaspi-poll: status fetch failed for payment=${paymentId} kg=${kindergartenId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return {
        outcome: 'reschedule',
        paymentCreatedAt: createdAt,
        expireDate: null,
      };
    }

    // Best-effort last_checked_at touch (debounce hook for a future on-demand
    // refresh). Never fail the tick on a touch error.
    try {
      await this.sessions.touchLastCheckedAtBypassRls(kindergartenId, now);
    } catch (err) {
      this.logger.warn(
        `kaspi-poll: last_checked_at touch failed for kg=${kindergartenId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const expireDate = details.expireDate;

    switch (details.kind) {
      case 'processed': {
        await this.paymentService.settleFromKaspiPoller(
          kindergartenId,
          paymentId,
          this.completedTerminal(providerTxnId, {
            status: 'Processed',
            source: 'kaspi_poller',
          }),
        );
        return { outcome: 'settled', paymentCreatedAt: createdAt, expireDate };
      }

      case 'terminal': {
        const reason = `kaspi_${details.rawStatus ?? 'terminal'}`;
        await this.paymentService.settleFromKaspiPoller(
          kindergartenId,
          paymentId,
          this.failedTerminal(providerTxnId, reason, {
            status: details.rawStatus,
          }),
        );
        return { outcome: 'failed', paymentCreatedAt: createdAt, expireDate };
      }

      case 'session_expired': {
        // Try the silent SignInLite refresh. On success the next tick polls
        // with the fresh session; the payment stays processing either way.
        try {
          await this.kaspiConnect.refreshSession(kindergartenId);
        } catch {
          // refreshSession already did markExpired + saveBypassRls. Alert the
          // kg admins to re-onboard, then keep the payment alive until
          // ExpireDate / hard-cap.
          await this.notifySessionExpired(kindergartenId);
        }
        // If the op's ExpireDate already passed, do not keep polling a dead op
        // until the 24h hard-cap — fail it now (mirrors the pending branch).
        if (expireDate && now.getTime() >= expireDate.getTime()) {
          this.warnForceFail(
            paymentId,
            kindergartenId,
            'expire_date',
            details.rawStatus,
          );
          await this.paymentService.settleFromKaspiPoller(
            kindergartenId,
            paymentId,
            this.failedTerminal(providerTxnId, 'kaspi_expired', {
              reason: 'expire_date_session_expired',
            }),
          );
          return { outcome: 'failed', paymentCreatedAt: createdAt, expireDate };
        }
        return {
          outcome: 'reschedule',
          paymentCreatedAt: createdAt,
          expireDate,
        };
      }

      case 'pending':
      default: {
        if (expireDate && now.getTime() >= expireDate.getTime()) {
          this.warnForceFail(
            paymentId,
            kindergartenId,
            'expire_date',
            details.rawStatus,
          );
          await this.paymentService.settleFromKaspiPoller(
            kindergartenId,
            paymentId,
            this.failedTerminal(providerTxnId, 'kaspi_expired', {
              status: details.rawStatus,
              reason: 'expire_date',
            }),
          );
          return { outcome: 'failed', paymentCreatedAt: createdAt, expireDate };
        }
        return {
          outcome: 'reschedule',
          paymentCreatedAt: createdAt,
          expireDate,
        };
      }
    }
  }

  /**
   * Resolve the kg's active admins and emit `kaspi.session_expired`. Both the
   * staff read and the FORCE-RLS outbox insert run under the kg GUC + tenant
   * context (the outbox adapter resolves its EntityManager from
   * `tenantStorage`). Admin user_ids are de-duplicated.
   */
  private async notifySessionExpired(kindergartenId: string): Promise<void> {
    await this.tx.run(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      await tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        async () => {
          const admins = await this.staffRepo.listByKindergarten(
            kindergartenId,
            { role: 'admin', isActive: true },
          );
          const recipientUserIds = Array.from(
            new Set(
              admins
                .map((s) => s.toState().userId)
                .filter((u): u is string => typeof u === 'string'),
            ),
          );
          if (recipientUserIds.length > 0) {
            await this.notificationPort.notifyKaspiSessionExpired({
              kindergartenId,
              recipientUserIds,
            });
          }
        },
      );
    });
  }

  /**
   * Loud WARN before force-failing a payment by ExpireDate / hard-cap. The
   * Kaspi `remote/details` response shape is UNVERIFIED (see the kaspi-remote-
   * details TODO): if the real "Processed" signal differs from the parser's
   * assumption, a genuinely-paid op would parse as `pending` and be force-
   * failed here — this makes that observable. Logs ids + rawStatus only; never
   * a secret.
   */
  private warnForceFail(
    paymentId: string,
    kindergartenId: string,
    via: 'hard_cap' | 'expire_date',
    rawStatus: string | null,
  ): void {
    this.logger.warn(
      `kaspi-poll: force-failing payment=${paymentId} kg=${kindergartenId} via ${via} (lastStatus=${rawStatus ?? 'none'}) — if Kaspi actually Processed this op, the remote/details parser shape may be wrong (see kaspi-remote-details TODO)`,
    );
  }

  private completedTerminal(
    providerPaymentId: string,
    raw: Record<string, unknown>,
  ): VerifyWebhookResult {
    return { providerPaymentId, status: 'completed', raw };
  }

  private failedTerminal(
    providerPaymentId: string,
    failureReason: string,
    raw: Record<string, unknown>,
  ): VerifyWebhookResult {
    return { providerPaymentId, status: 'failed', failureReason, raw };
  }
}
