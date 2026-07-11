import { Injectable } from '@nestjs/common';
import { BccCheckoutExpiredError } from './domain/errors/bcc-checkout-expired.error';
import {
  BccCheckoutPage,
  renderBccCheckoutPage,
  renderBccReturnPage,
} from './infrastructure/checkout/bcc-checkout-html';
import { BccCheckoutStorePort } from './infrastructure/checkout/bcc-checkout-store.port';
import { PaymentRepository } from './infrastructure/persistence/payment.repository';

@Injectable()
export class BccCheckoutService {
  constructor(
    private readonly checkoutStore: BccCheckoutStorePort,
    private readonly payments: PaymentRepository,
  ) {}

  async consume(token: string, clientIp: string): Promise<BccCheckoutPage> {
    const session = await this.checkoutStore.consume(token);
    if (!session) throw new BccCheckoutExpiredError();

    const payment = await this.payments.findByIdCrossTenant(
      session.kindergartenId,
      session.paymentId,
    );
    if (
      !payment ||
      payment.provider !== 'bcc' ||
      payment.kindergartenId !== session.kindergartenId ||
      payment.providerTxnId !== session.order ||
      (payment.status !== 'initiated' && payment.status !== 'processing')
    ) {
      throw new BccCheckoutExpiredError();
    }
    return renderBccCheckoutPage(session, clientIp);
  }

  renderReturn(): BccCheckoutPage {
    return renderBccReturnPage();
  }
}
