import { ExecutionContext, NotFoundException } from '@nestjs/common';
import {
  Invoice,
  InvoiceState,
} from '@/modules/billing/domain/entities/invoice.entity';
import { InvoiceRepository } from '@/modules/billing/infrastructure/persistence/invoice.repository';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { InvoiceAccessGuard } from './invoice-access.guard';

const KG_B = '22222222-2222-2222-2222-222222222222';
const CHILD_B = '44444444-4444-4444-4444-444444444444';
const PARENT = '55555555-5555-5555-5555-555555555555';
const INVOICE_ID = '77777777-7777-7777-7777-777777777777';
const NOW = new Date('2026-06-11T12:00:00.000Z');

interface ReqShape {
  user?: { sub: string; role: string; kindergarten_id?: string | null };
  params: Record<string, string | undefined>;
  tenant?: { kgId: string | null; bypass: boolean };
}

function makeCtx(req: ReqShape): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeInvoice(args: {
  id: string;
  kg: string;
  childId: string;
}): Invoice {
  const state: InvoiceState = {
    id: args.id,
    kindergartenId: args.kg,
    childId: args.childId,
    paymentAccountId: 'pa-1',
    tariffPlanId: null,
    invoiceType: 'monthly',
    periodStart: new Date('2026-06-01T00:00:00.000Z'),
    periodEnd: new Date('2026-06-30T00:00:00.000Z'),
    amountDue: MoneyKzt.fromKzt(50000),
    discountPct: null,
    discountReason: null,
    amountAfterDiscount: MoneyKzt.fromKzt(50000),
    status: 'pending',
    dueDate: new Date('2026-06-10T00:00:00.000Z'),
    description: null,
    proratedForDays: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return Invoice.fromState(state);
}

class FakeRepo extends InvoiceRepository {
  constructor(private readonly rows: Invoice[]) {
    super();
  }
  override findByIdCrossTenant(id: string): Promise<Invoice | null> {
    return Promise.resolve(this.rows.find((i) => i.id === id) ?? null);
  }
  // Unused abstract stubs.
  create(): Promise<Invoice> {
    return Promise.reject(new Error('unused'));
  }
  findById(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  list(): Promise<Invoice[]> {
    return Promise.resolve([]);
  }
  findByChildId(): Promise<Invoice[]> {
    return Promise.resolve([]);
  }
  existsMonthlyForPeriod(): Promise<boolean> {
    return Promise.resolve(false);
  }
  getPaidSumForInvoice(): Promise<number> {
    return Promise.resolve(0);
  }
  getPaidSumsForInvoices(): Promise<Map<string, number>> {
    return Promise.resolve(new Map());
  }
  getOutstandingByChild(): Promise<Map<string, number>> {
    return Promise.resolve(new Map());
  }
  markPaidConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markPartialConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markCancelledConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markRefundedConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  markOverdueConditional(): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  acquireMonthlyGenerationAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
}

describe('InvoiceAccessGuard', () => {
  it('pins req.tenant to the kg of the invoice resolved by :id (resource in another kg)', async () => {
    // Unscoped parent JWT; invoice lives in KG_B. The guard resolves the kg
    // from the resource and pins it — no token-kg. Authorisation (guardian /
    // canPay) is enforced by the service afterwards.
    const inv = makeInvoice({ id: INVOICE_ID, kg: KG_B, childId: CHILD_B });
    const guard = new InvoiceAccessGuard(new FakeRepo([inv]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent', kindergarten_id: null },
      params: { id: INVOICE_ID },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_B, bypass: false });
  });

  it('throws NotFoundException when the id resolves to no invoice anywhere', async () => {
    const guard = new InvoiceAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent', kindergarten_id: null },
      params: { id: INVOICE_ID },
    };
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(req.tenant).toBeUndefined();
  });

  it('skips for non-parent roles without clobbering req.tenant', async () => {
    const guard = new InvoiceAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'admin', kindergarten_id: KG_B },
      params: { id: INVOICE_ID },
      tenant: { kgId: KG_B, bypass: false },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_B, bypass: false });
  });
});
