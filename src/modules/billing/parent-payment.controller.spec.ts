import type { JwtPayload } from '@/common/types/jwt-payload';
import type { TenantContext } from '@/shared-kernel/application/tenant/tenant-context';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Invoice, InvoiceState } from './domain/entities/invoice.entity';
import { Payment } from './domain/entities/payment.entity';
import { InitiatePrepaymentDto } from './dto/payment.dto';
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
const PREPAY_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
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

function makePrepaymentInvoice(id: string): Invoice {
  return makeInvoice({
    id,
    invoiceType: 'prepayment_3m',
    periodStart: new Date('2026-07-01T00:00:00.000Z'),
    periodEnd: new Date('2026-09-30T00:00:00.000Z'),
    amountDue: m(180000),
    discountPct: 10,
    amountAfterDiscount: m(162000),
    dueDate: new Date('2026-06-22T00:00:00.000Z'),
    description: 'Prepayment 3m — 2026-07-01..2026-09-30',
  });
}

function makePayment(id: string, invoiceId: string): Payment {
  return Payment.fromState({
    id,
    kindergartenId: KG,
    invoiceId,
    childId: CHILD,
    payerUserId: USER,
    amount: m(162000),
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
  prepayCalls: Array<{ kg: string; childId: string; months: number }> = [];
  prepayResult: Invoice | null = null;

  get(_kg: string, id: string): Promise<Invoice> {
    const inv = this.invoices.get(id);
    if (!inv) return Promise.reject(new Error(`invoice_not_found:${id}`));
    return Promise.resolve(inv);
  }

  prepayInvoice(kg: string, childId: string, months: number): Promise<Invoice> {
    this.prepayCalls.push({ kg, childId, months });
    if (!this.prepayResult) {
      return Promise.reject(new Error('prepayResult not seeded'));
    }
    return Promise.resolve(this.prepayResult);
  }
}

class FakePaymentService {
  existingByKey: Payment | null = null;
  initiateCalls: InitiatePaymentInput[] = [];
  initiateResult: InitiatePaymentResult | null = null;

  assertCanPay(): Promise<void> {
    return Promise.resolve();
  }

  assertProviderEnabled(): void {}

  findByIdempotencyKey(): Promise<Payment | null> {
    return Promise.resolve(this.existingByKey);
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

function makeDto(): InitiatePrepaymentDto {
  const dto = new InitiatePrepaymentDto();
  dto.months = 3;
  dto.provider = 'mock';
  dto.idempotency_key = IDEM;
  dto.return_url = 'https://app.shyraq.kz/payment/prepayment/callback';
  return dto;
}

const tenant = { kgId: KG } as TenantContext;
const user = { sub: USER } as JwtPayload;

describe('ParentPaymentController.initiatePrepayment — idempotency short-circuit (FIX 1)', () => {
  it('returns the existing payment and ITS invoice on a same-key retry without calling prepayInvoice', async () => {
    const { controller, invoiceService, paymentService } = buildController();
    invoiceService.invoices.set(ANCHOR, makeInvoice());
    invoiceService.invoices.set(PREPAY_A, makePrepaymentInvoice(PREPAY_A));
    const existing = makePayment('pmt-a', PREPAY_A);
    paymentService.existingByKey = existing;
    paymentService.initiateResult = {
      payment: existing,
      redirectUrl: 'https://mock/pay/prep-a',
    };

    const res = await controller.initiatePrepayment(
      tenant,
      user,
      ANCHOR,
      makeDto(),
    );

    // The retry cancelled/created NOTHING — prepayInvoice never ran.
    expect(invoiceService.prepayCalls).toHaveLength(0);
    // Payment + invoice pair is the ORIGINAL one (no mismatch).
    expect(res.payment_id).toBe('pmt-a');
    expect(res.invoice_id).toBe(PREPAY_A);
    expect(res.redirect_url).toBe('https://mock/pay/prep-a');
    expect(res.preview).toEqual({
      base_amount: 180000,
      discount_pct: 10,
      final_amount: 162000,
      covers_period: { from: '2026-07-01', to: '2026-09-30' },
    });
    // The redirect/deeplink recovery goes through initiate's fast-path,
    // targeted at the EXISTING invoice.
    expect(paymentService.initiateCalls).toHaveLength(1);
    expect(paymentService.initiateCalls[0]).toMatchObject({
      invoiceId: PREPAY_A,
      idempotencyKey: IDEM,
    });
  });

  it('creates the prepayment invoice and initiates payment on a fresh idempotency key', async () => {
    const { controller, invoiceService, paymentService } = buildController();
    invoiceService.invoices.set(ANCHOR, makeInvoice());
    const created = makePrepaymentInvoice(PREPAY_A);
    invoiceService.prepayResult = created;
    paymentService.existingByKey = null;
    paymentService.initiateResult = {
      payment: makePayment('pmt-new', PREPAY_A),
      redirectUrl: 'https://mock/pay/new',
    };

    const res = await controller.initiatePrepayment(
      tenant,
      user,
      ANCHOR,
      makeDto(),
    );

    expect(invoiceService.prepayCalls).toEqual([
      { kg: KG, childId: CHILD, months: 3 },
    ]);
    expect(res.invoice_id).toBe(PREPAY_A);
    expect(res.payment_id).toBe('pmt-new');
    expect(paymentService.initiateCalls[0]).toMatchObject({
      invoiceId: PREPAY_A,
      amount: 162000,
      paymentMode: 'full',
    });
  });
});
