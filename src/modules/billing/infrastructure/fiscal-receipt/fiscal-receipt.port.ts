/**
 * FiscalReceiptPort — abstraction over OFD (Online Fiscal Data) providers.
 *
 * In Kazakhstan every payment over a regulated threshold must produce a
 * fiscal receipt that is mirrored to a state-approved OFD. B15 will pick a
 * concrete provider (Kassa24 / Rekassa / Webkassa). Until then the Mock
 * adapter is the only implementation — it logs and returns a deterministic
 * fiscal sign so downstream code (and tests) can assert receipt emission
 * without standing up a real OFD.
 *
 * Lives under `billing/infrastructure/` because emission is triggered from
 * `payment.service.processWebhook` (B13 T5c) — the receipt is a side-effect
 * of a successful payment. If a future module needs receipts independently
 * (subscription renewal, salary payouts, etc.) the port can graduate to
 * `shared-kernel/` without changing its contract.
 */

export interface EmitReceiptInput {
  paymentId: string;
  invoiceId: string;
  kindergartenId: string;
  amountKzt: number;
  paidAt: Date;
  payerName?: string;
  payerPhone?: string;
}

export interface EmitReceiptResult {
  /** Unique receipt sign / QR token returned by the OFD. */
  fiscalSign: string;
  ofdStatus: 'queued' | 'sent' | 'failed';
  qrUrl?: string;
}

export abstract class FiscalReceiptPort {
  abstract emitReceipt(input: EmitReceiptInput): Promise<EmitReceiptResult>;
}
