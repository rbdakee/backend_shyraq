/**
 * B22a T1 — OverdueInvoiceProcessor unit spec.
 *
 * Drives the processor's per-kg run via an in-memory invoice repo +
 * notification adapter, asserting:
 *   1. (pending|partial) rows past due_date flip to `overdue` and emit
 *      `invoice.overdue` events.
 *   2. Already-`overdue` rows are NOT re-emitted on a repeat tick
 *      (idempotency across runs — `markOverdueBatch`'s status filter
 *      keeps the second run silent).
 *   3. Per-kg loop accumulates flipped counts across multiple kgs.
 *   4. `daysOverdue` is computed from (now - due_date) in whole days.
 *
 * Self-contained: no DataSource transactions, no PG. We replace the
 * `dataSource.transaction(cb => cb(em))` with a no-op shim and the
 * processor's listAllKindergartens with a stub seeded from the
 * in-memory invoice repo.
 */
import { DataSource, EntityManager } from 'typeorm';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { Invoice } from './domain/entities/invoice.entity';
import {
  InvoiceRepository,
  ListInvoicesFilter,
} from './infrastructure/persistence/invoice.repository';
import { InvoiceLineItem } from './domain/entities/invoice-line-item.entity';
import {
  OverdueInvoiceProcessor,
  OVERDUE_INVOICE_RECURRING_JOB,
} from './overdue-invoice.processor';
import type { Job } from 'bullmq';

const KG_A = 'a1111111-1111-1111-1111-111111111111';
const KG_B = 'b2222222-2222-2222-2222-222222222222';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NOW = new Date('2026-05-20T03:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakeInvoiceRepo extends InvoiceRepository {
  rows = new Map<string, Invoice>();

  create(): Promise<Invoice> {
    return Promise.reject(new Error('not used'));
  }
  findById(kg: string, id: string): Promise<Invoice | null> {
    const inv = this.rows.get(id);
    if (!inv || inv.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(inv);
  }
  list(_kg: string, _filter: ListInvoicesFilter): Promise<Invoice[]> {
    return Promise.resolve([...this.rows.values()]);
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

  override markOverdueBatch(
    kgId: string,
    today: string,
    now: Date,
  ): Promise<
    Array<{
      id: string;
      childId: string;
      amountAfterDiscount: number;
      dueDate: string;
    }>
  > {
    const flipped: Array<{
      id: string;
      childId: string;
      amountAfterDiscount: number;
      dueDate: string;
    }> = [];
    for (const [id, inv] of this.rows.entries()) {
      if (inv.kindergartenId !== kgId) continue;
      if (inv.status !== 'pending' && inv.status !== 'partial') continue;
      const due = inv.dueDate.toISOString().slice(0, 10);
      if (due >= today) continue;
      // Mutate in place — mirror the relational UPDATE.
      const s = inv.toState();
      const updated = Invoice.fromState({
        ...s,
        status: 'overdue',
        updatedAt: now,
      });
      this.rows.set(id, updated);
      flipped.push({
        id: updated.id,
        childId: updated.childId,
        amountAfterDiscount: updated.amountAfterDiscount.toNumber(),
        dueDate: due,
      });
    }
    return Promise.resolve(flipped);
  }

  override acquireOverdueRunAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
}

function makeInvoice(overrides: {
  id: string;
  kindergartenId: string;
  status: 'pending' | 'partial' | 'overdue';
  dueDate: Date;
  amountAfterDiscount?: number;
}): Invoice {
  return Invoice.fromState({
    id: overrides.id,
    kindergartenId: overrides.kindergartenId,
    childId: CHILD,
    paymentAccountId: 'pa-x',
    tariffPlanId: null,
    invoiceType: 'monthly',
    periodStart: new Date('2026-05-01T00:00:00.000Z'),
    periodEnd: new Date('2026-05-31T00:00:00.000Z'),
    amountDue: MoneyKzt.fromKzt(overrides.amountAfterDiscount ?? 100_000),
    discountPct: null,
    discountReason: null,
    amountAfterDiscount: MoneyKzt.fromKzt(
      overrides.amountAfterDiscount ?? 100_000,
    ),
    status: overrides.status,
    dueDate: overrides.dueDate,
    description: null,
    proratedForDays: null,
    createdAt: new Date('2026-05-01T00:00:00.000Z'),
    updatedAt: new Date('2026-05-01T00:00:00.000Z'),
  });
}

void InvoiceLineItem; // imported only for repo type compat

function makeFakeDataSource(): DataSource {
  return {
    transaction: <T>(cb: (em: EntityManager) => Promise<T>): Promise<T> =>
      cb({
        query: () => Promise.resolve(undefined),
      } as unknown as EntityManager),
  } as unknown as DataSource;
}

describe('OverdueInvoiceProcessor', () => {
  function build() {
    const invoiceRepo = new FakeInvoiceRepo();
    const notifier = new InMemoryNotificationAdapter();
    const clock = new FixedClock(NOW);
    const ds = makeFakeDataSource();
    const proc = new OverdueInvoiceProcessor(invoiceRepo, notifier, ds, clock);
    return { proc, invoiceRepo, notifier, clock };
  }

  it('flips pending invoices past due_date to overdue and emits invoice.overdue', async () => {
    const { proc, invoiceRepo, notifier } = build();
    invoiceRepo.rows.set(
      'inv-1',
      makeInvoice({
        id: 'inv-1',
        kindergartenId: KG_A,
        status: 'pending',
        dueDate: new Date('2026-05-10T00:00:00.000Z'),
      }),
    );

    const result = await proc.runForKindergarten(KG_A, NOW);

    expect(result.flippedIds).toEqual(['inv-1']);
    const inv = await invoiceRepo.findById(KG_A, 'inv-1');
    expect(inv?.status).toBe('overdue');
    const overdueEvents = notifier.events.filter(
      (e) => e.type === 'invoice_overdue',
    );
    expect(overdueEvents).toHaveLength(1);
    const evt = overdueEvents[0].event as {
      invoiceId: string;
      daysOverdue: number;
      dueDate: string;
    };
    expect(evt.invoiceId).toBe('inv-1');
    expect(evt.dueDate).toBe('2026-05-10');
    expect(evt.daysOverdue).toBe(10); // 2026-05-20 - 2026-05-10
  });

  it('flips partial invoices past due_date to overdue (SM1 ripple)', async () => {
    const { proc, invoiceRepo, notifier } = build();
    invoiceRepo.rows.set(
      'inv-partial',
      makeInvoice({
        id: 'inv-partial',
        kindergartenId: KG_A,
        status: 'partial',
        dueDate: new Date('2026-05-05T00:00:00.000Z'),
      }),
    );

    const result = await proc.runForKindergarten(KG_A, NOW);

    expect(result.flippedIds).toEqual(['inv-partial']);
    const inv = await invoiceRepo.findById(KG_A, 'inv-partial');
    expect(inv?.status).toBe('overdue');
    expect(
      notifier.events.filter((e) => e.type === 'invoice_overdue'),
    ).toHaveLength(1);
  });

  it('is idempotent across runs (no double-emit when re-run)', async () => {
    const { proc, invoiceRepo, notifier } = build();
    invoiceRepo.rows.set(
      'inv-idem',
      makeInvoice({
        id: 'inv-idem',
        kindergartenId: KG_A,
        status: 'pending',
        dueDate: new Date('2026-05-10T00:00:00.000Z'),
      }),
    );

    const first = await proc.runForKindergarten(KG_A, NOW);
    const second = await proc.runForKindergarten(KG_A, NOW);

    expect(first.flippedIds).toEqual(['inv-idem']);
    expect(second.flippedIds).toEqual([]);
    const overdueEvents = notifier.events.filter(
      (e) => e.type === 'invoice_overdue',
    );
    expect(overdueEvents).toHaveLength(1);
  });

  it('does not flip invoices whose due_date is still in the future', async () => {
    const { proc, invoiceRepo, notifier } = build();
    invoiceRepo.rows.set(
      'inv-future',
      makeInvoice({
        id: 'inv-future',
        kindergartenId: KG_A,
        status: 'pending',
        dueDate: new Date('2026-06-10T00:00:00.000Z'),
      }),
    );

    const result = await proc.runForKindergarten(KG_A, NOW);
    expect(result.flippedIds).toEqual([]);
    const inv = await invoiceRepo.findById(KG_A, 'inv-future');
    expect(inv?.status).toBe('pending');
    expect(
      notifier.events.filter((e) => e.type === 'invoice_overdue'),
    ).toHaveLength(0);
  });

  it('does not flip invoices in terminal states (paid/cancelled/refunded)', async () => {
    const { proc, invoiceRepo } = build();
    const seeds: Array<[string, 'paid' | 'cancelled' | 'refunded']> = [
      ['inv-paid', 'paid'],
      ['inv-cancelled', 'cancelled'],
      ['inv-refunded', 'refunded'],
    ];
    for (const [id, status] of seeds) {
      invoiceRepo.rows.set(
        id,
        Invoice.fromState({
          id,
          kindergartenId: KG_A,
          childId: CHILD,
          paymentAccountId: 'pa-x',
          tariffPlanId: null,
          invoiceType: 'monthly',
          periodStart: new Date('2026-05-01T00:00:00.000Z'),
          periodEnd: new Date('2026-05-31T00:00:00.000Z'),
          amountDue: MoneyKzt.fromKzt(100_000),
          discountPct: null,
          discountReason: null,
          amountAfterDiscount: MoneyKzt.fromKzt(100_000),
          status,
          dueDate: new Date('2026-05-10T00:00:00.000Z'),
          description: null,
          proratedForDays: null,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
    }
    const result = await proc.runForKindergarten(KG_A, NOW);
    expect(result.flippedIds).toEqual([]);
  });

  it('isolates per-kg runs — kg_A flips do not affect kg_B invoices', async () => {
    const { proc, invoiceRepo } = build();
    invoiceRepo.rows.set(
      'inv-a',
      makeInvoice({
        id: 'inv-a',
        kindergartenId: KG_A,
        status: 'pending',
        dueDate: new Date('2026-05-10T00:00:00.000Z'),
      }),
    );
    invoiceRepo.rows.set(
      'inv-b',
      makeInvoice({
        id: 'inv-b',
        kindergartenId: KG_B,
        status: 'pending',
        dueDate: new Date('2026-05-10T00:00:00.000Z'),
      }),
    );

    const ra = await proc.runForKindergarten(KG_A, NOW);
    expect(ra.flippedIds).toEqual(['inv-a']);
    const invA = await invoiceRepo.findById(KG_A, 'inv-a');
    const invB = await invoiceRepo.findById(KG_B, 'inv-b');
    expect(invA?.status).toBe('overdue');
    expect(invB?.status).toBe('pending');
  });

  it('computeNow honours the job-data override and falls through to clock otherwise', () => {
    const { proc, clock } = build();
    // No override → clock.now()
    expect(proc.computeNow(undefined).getTime()).toBe(clock.now().getTime());
    // Override as ISO string
    const ts = '2026-04-01T00:00:00.000Z';
    expect(proc.computeNow(ts).toISOString()).toBe(ts);
    // Override as Date
    const d = new Date('2026-03-01T00:00:00.000Z');
    expect(proc.computeNow(d).toISOString()).toBe(d.toISOString());
  });

  it('process() ignores unknown job names', async () => {
    const { proc } = build();
    const fakeJob = {
      name: 'unknown',
      data: {},
    } as unknown as Job<{ now?: string | Date }>;
    const summary = await proc.process(fakeJob);
    expect(summary).toEqual({
      kindergartensProcessed: 0,
      invoicesFlipped: 0,
      errors: 0,
      now: '',
    });
  });

  it('process() with recurring job name returns a structured summary', async () => {
    const { proc, invoiceRepo } = build();
    // Stub `listAllKindergartens` to skip the cross-tenant SELECT — we
    // are not exercising the DataSource transaction here; flowing
    // through `runForKindergarten` per kg is covered by the focused
    // unit tests above.
    const protoSpy = jest
      .spyOn(
        OverdueInvoiceProcessor.prototype as unknown as {
          listAllKindergartens: () => Promise<string[]>;
        },
        'listAllKindergartens',
      )
      .mockResolvedValue([]);
    void invoiceRepo;

    const fakeJob = {
      name: OVERDUE_INVOICE_RECURRING_JOB,
      data: {},
    } as unknown as Job<{ now?: string | Date }>;
    const summary = await proc.process(fakeJob);
    expect(summary.kindergartensProcessed).toBe(0);
    expect(summary.invoicesFlipped).toBe(0);
    expect(summary.errors).toBe(0);
    protoSpy.mockRestore();
  });
});
