import { randomBytes } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  EmitReceiptInput,
  EmitReceiptResult,
  FiscalReceiptPort,
} from './fiscal-receipt.port';

/**
 * MockFiscalReceiptAdapter — default `FISCAL_PROVIDER=mock`. Generates a
 * deterministically-shaped fiscal sign and returns `ofdStatus='queued'` so
 * downstream tests can assert "receipt was emitted" without depending on a
 * real OFD callback. Real providers (B15) will return `'sent'` or `'failed'`
 * synchronously, or surface async OFD-status updates via a separate poll.
 */
@Injectable()
export class MockFiscalReceiptAdapter extends FiscalReceiptPort {
  private readonly logger = new Logger('MockFiscalReceiptAdapter');

  emitReceipt(input: EmitReceiptInput): Promise<EmitReceiptResult> {
    const fiscalSign = `mock_fiscal_${randomBytes(8).toString('hex')}`;
    this.logger.log(
      `[MockFiscal] payment=${input.paymentId} invoice=${input.invoiceId} amount=${input.amountKzt} → ${fiscalSign}`,
    );
    return Promise.resolve({
      fiscalSign,
      ofdStatus: 'queued',
      qrUrl: `https://mock.ofd.local/r/${fiscalSign}`,
    });
  }
}
