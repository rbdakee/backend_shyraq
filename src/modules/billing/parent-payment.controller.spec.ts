import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Invoice, InvoiceState } from './domain/entities/invoice.entity';
import { Payment } from './domain/entities/payment.entity';
import { InitiatePaymentDto } from './dto/payment.dto';
import { InvoiceService } from './invoice.service';
import { ParentPaymentController } from './parent-payment.controller';
import {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentService,
} from './payment.service';
import { UserPaymentProfileService } from './user-payment-profile.service';

const m = (n: number): MoneyKzt => MoneyKzt.fromKzt(n);

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER = 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu';
const ANCHOR = 'aaaaaaaa-0000-0000-0000-000000000001';
const IDEM = 'b2c3d4e5-f6a7-8901-bcde-f12345678901';
const NOW = new Date('2026-06-15T09:00:00.000Z');

function makeInvoice(overrides: Partial<InvoiceState> = {}): Invoice {
  return Invoice.fromState({
    id: ANCHOR,
    kindergartenId: KG,
    childId: CHILD,
    paymentAccountId: 'pa-1',
    tariffPlanId: null,
    invoiceType: 'monthly',
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    amountDue: m(50000),
    discountPct: null,
    discountReason: null,
    amountAfterDiscount: m(50000),
    status: 'pending',
    dueDate: new Date('2026-06-10T00:00:00.000Z'),
    description: null,
    proratedForDays: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function makePayment(id: string, invoiceId: string): Payment {
  return Payment.fromState({
    id,
    kindergartenId: KG,
    invoiceId,
    childId: CHILD,
    payerUserId: USER,
    amount: m(30000),
    provider: 'mock',
    providerTxnId: 'tx-1',
    idempotencyKey: IDEM,
    status: 'processing',
    providerPayload: null,
    paidAt: null,
    refundId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

class FakeInvoiceService {
  invoices = new Map<string, Invoice>();
  paidSums = new Map<string, number>();

  get(_kg: string, id: string): Promise<Invoice> {
    const inv = this.invoices.get(id);
    if (!inv) return Promise.reject(new Error(`invoice_not_found:${id}`));
    return Promise.resolve(inv);
  }

  getPaidSum(_kg: string, id: string): Promise<number> {
    return Promise.resolve(this.paidSums.get(id) ?? 0);
  }
}

class FakePaymentService {
  initiateCalls: InitiatePaymentInput[] = [];
  initiateResult: InitiatePaymentResult | null = null;

  assertCanPay(): Promise<void> {
    return Promise.resolve();
  }

  assertProviderEnabled(): void {}

  findByIdempotencyKey(): Promise<Payment | null> {
    return Promise.resolve(null);
  }

  initiate(
    _kg: string,
    input: InitiatePaymentInput,
  ): Promise<InitiatePaymentResult> {
    this.initiateCalls.push(input);
    if (!this.initiateResult) {
      return Promise.reject(new Error('initiateResult not seeded'));
    }
    return Promise.resolve(this.initiateResult);
  }
}

function buildController() {
  const invoiceService = new FakeInvoiceService();
  const paymentService = new FakePaymentService();
  const controller = new ParentPaymentController(
    invoiceService as unknown as InvoiceService,
    paymentService as unknown as PaymentService,
    { save: () => Promise.resolve() } as unknown as UserPaymentProfileService,
  );
  return { controller, invoiceService, paymentService };
}

const tenant = { kgId: KG } as TenantContext;
const user = { sub: USER } as JwtPayload;

describe('ParentPaymentController.initiatePay — full mode settles the remainder', () => {
  function makePayDto(
    mode: 'full' | 'partial',
    amount?: number,
  ): InitiatePaymentDto {
    const dto = new InitiatePaymentDto();
    dto.provider = 'mock';
    dto.payment_mode = mode;
    dto.idempotency_key = IDEM;
    dto.return_url = 'https://app.shyraq.kz/payment/callback';
    if (amount !== undefined) dto.amount = amount;
    return dto;
  }

  it('sends the outstanding balance, not amount_after_discount, on a partially paid invoice', async () => {
    const { controller, invoiceService, paymentService } = buildController();
    invoiceService.invoices.set(ANCHOR, makeInvoice({ status: 'partial' }));
    invoiceService.paidSums.set(ANCHOR, 20000);
    paymentService.initiateResult = {
      payment: makePayment('pmt-rest', ANCHOR),
      redirectUrl: 'https://mock/pay/rest',
    };

    await controller.initiatePay(tenant, user, ANCHOR, makePayDto('full'));

    expect(paymentService.initiateCalls[0]).toMatchObject({
      invoiceId: ANCHOR,
      amount: 30000,
      paymentMode: 'full',
    });
  });

  it('sends the full amount when nothing has been paid yet', async () => {
    const { controller, invoiceService, paymentService } = buildController();
    invoiceService.invoices.set(ANCHOR, makeInvoice());
    paymentService.initiateResult = {
      payment: makePayment('pmt-fresh', ANCHOR),
      redirectUrl: 'https://mock/pay/fresh',
    };

    await controller.initiatePay(tenant, user, ANCHOR, makePayDto('full'));

    expect(paymentService.initiateCalls[0]).toMatchObject({
      amount: 50000,
      paymentMode: 'full',
    });
  });

  it('keeps sub-tenge remainders exact instead of drifting through float math', async () => {
    const { controller, invoiceService, paymentService } = buildController();
    invoiceService.invoices.set(
      ANCHOR,
      makeInvoice({ status: 'partial', amountAfterDiscount: m(13.5) }),
    );
    invoiceService.paidSums.set(ANCHOR, 0.1);
    paymentService.initiateResult = {
      payment: makePayment('pmt-frac', ANCHOR),
      redirectUrl: 'https://mock/pay/frac',
    };

    await controller.initiatePay(tenant, user, ANCHOR, makePayDto('full'));

    expect(paymentService.initiateCalls[0].amount).toBe(13.4);
  });

  it('passes the client amount through untouched in partial mode', async () => {
    const { controller, invoiceService, paymentService } = buildController();
    invoiceService.invoices.set(ANCHOR, makeInvoice({ status: 'partial' }));
    invoiceService.paidSums.set(ANCHOR, 20000);
    paymentService.initiateResult = {
      payment: makePayment('pmt-part', ANCHOR),
      redirectUrl: 'https://mock/pay/part',
    };

    await controller.initiatePay(
      tenant,
      user,
      ANCHOR,
      makePayDto('partial', 10000),
    );

    expect(paymentService.initiateCalls[0]).toMatchObject({
      amount: 10000,
      paymentMode: 'partial',
    });
  });
});
