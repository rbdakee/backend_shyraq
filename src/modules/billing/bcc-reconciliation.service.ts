import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Payment } from './domain/entities/payment.entity';
import {
  BCC_RECONCILIATION_HARD_CAP_MS,
  BCC_RECONCILIATION_MAX_DELAY_MS,
  bccReconciliationDelayMs,
} from './bcc-reconciliation.constants';
import {
  isBccSuccess,
  isBccTerminalFailure,
} from './infrastructure/payment-provider/bcc/bcc-callback';
import { BccPaymentProvider } from './infrastructure/payment-provider/bcc/bcc-payment-provider.adapter';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';
import { PaymentService } from './payment.service';

export type BccReconciliationOutcome =
  | 'settled'
  | 'failed'
  | 'reschedule'
  | 'manual_review'
  | 'stop';

export interface BccReconciliationResult {
  outcome: BccReconciliationOutcome;
  nextAt: Date | null;
}

@Injectable()
export class BccReconciliationService {
  private readonly logger = new Logger(BccReconciliationService.name);

  constructor(
    private readonly provider: BccPaymentProvider,
    private readonly payments: PaymentService,
    private readonly paymentRepo: PaymentRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async reconcileOnce(
    kindergartenId: string,
    paymentId: string,
  ): Promise<BccReconciliationResult> {
    const payment = await this.paymentRepo.findByIdCrossTenant(
      kindergartenId,
      paymentId,
    );
    if (
      !payment ||
      payment.provider !== 'bcc' ||
      payment.status !== 'processing'
    ) {
      return { outcome: 'stop', nextAt: null };
    }

    const now = this.clock.now();
    const hardCapAt = new Date(
      payment.createdAt.getTime() + BCC_RECONCILIATION_HARD_CAP_MS,
    );
    if (now >= hardCapAt) {
      await this.paymentRepo.markBccManualReviewCrossTenant(
        kindergartenId,
        paymentId,
        now,
      );
      this.logOutcome('manual_review', paymentId, payment.createdAt, now);
      return { outcome: 'manual_review', nextAt: null };
    }

    const leaseUntil = new Date(
      now.getTime() + BCC_RECONCILIATION_MAX_DELAY_MS,
    );
    const claimed = await this.paymentRepo.claimBccReconciliationCrossTenant(
      kindergartenId,
      paymentId,
      now,
      leaseUntil,
    );
    if (!claimed) {
      const refreshed = await this.paymentRepo.findByIdCrossTenant(
        kindergartenId,
        paymentId,
      );
      if (
        refreshed?.provider === 'bcc' &&
        refreshed.status === 'processing' &&
        refreshed.nextReconciliationAt
      ) {
        return {
          outcome: 'reschedule',
          nextAt: refreshed.nextReconciliationAt,
        };
      }
      return { outcome: 'stop', nextAt: null };
    }

    try {
      const response = await this.provider.getPaymentStatus({
        kindergartenId,
        order: claimed.providerTxnId ?? '',
      });
      const diagnostics = response.diagnostics;
      if (
        (diagnostics.order && diagnostics.order !== claimed.providerTxnId) ||
        !response.httpOk
      ) {
        return this.reschedule(claimed, hardCapAt, now);
      }
      const raw = {
        action: diagnostics.action,
        rc: diagnostics.rc,
        rc_text: sanitizeText(diagnostics.rcText),
        rrn: sanitizeIdentifier(diagnostics.rrn),
        int_ref: sanitizeIdentifier(diagnostics.intRef),
        source: 'bcc_reconciliation',
        tran_trtype: '1',
      };
      if (isBccSuccess(diagnostics.action, diagnostics.rc)) {
        await this.payments.settleFromBccReconciliation(
          kindergartenId,
          paymentId,
          {
            providerPaymentId: claimed.providerTxnId ?? '',
            status: 'completed',
            raw,
          },
        );
        this.logOutcome('settled', paymentId, claimed.createdAt, now);
        return { outcome: 'settled', nextAt: null };
      }
      if (isBccTerminalFailure(diagnostics.action, diagnostics.rc)) {
        await this.payments.settleFromBccReconciliation(
          kindergartenId,
          paymentId,
          {
            providerPaymentId: claimed.providerTxnId ?? '',
            status: 'failed',
            failureReason: `bcc_rc_${diagnostics.rc ?? 'unknown'}`,
            raw,
          },
        );
        this.logOutcome('failed', paymentId, claimed.createdAt, now);
        return { outcome: 'failed', nextAt: null };
      }
      return this.reschedule(claimed, hardCapAt, now);
    } catch {
      return this.reschedule(claimed, hardCapAt, now);
    }
  }

  private async reschedule(
    payment: Payment,
    hardCapAt: Date,
    now: Date,
  ): Promise<BccReconciliationResult> {
    const delay = bccReconciliationDelayMs(payment.reconciliationAttempts);
    const nextAt = new Date(
      Math.min(hardCapAt.getTime(), now.getTime() + delay),
    );
    await this.paymentRepo.rescheduleBccReconciliationCrossTenant(
      payment.kindergartenId,
      payment.id,
      nextAt,
      now,
    );
    this.logOutcome('reschedule', payment.id, payment.createdAt, now);
    return { outcome: 'reschedule', nextAt };
  }

  private logOutcome(
    outcome: BccReconciliationOutcome,
    paymentId: string,
    createdAt: Date,
    now: Date,
  ): void {
    this.logger.log(
      `bcc-reconciliation outcome=${outcome} payment=${paymentId} pending_age_ms=${Math.max(0, now.getTime() - createdAt.getTime())}`,
    );
  }
}

function sanitizeText(value: string | null): string | null {
  return value?.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160) ?? null;
}

function sanitizeIdentifier(value: string | null): string | null {
  return value && /^[0-9A-Za-z_-]{1,128}$/.test(value) ? value : null;
}
