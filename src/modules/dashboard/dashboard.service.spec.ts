/**
 * DashboardService — service-unit suite. Hand-written in-memory fakes for
 * every collaborator port (no Jest auto-mock), per CLAUDE.md §7 and
 * DASHBOARD_BACKEND_PLAN §4.
 *
 * Coverage matrix:
 *   - summary: composes every field from the right port.
 *   - summary: empty kindergarten → all zeros.
 *   - summary revenue: Asia/Almaty month/year boundaries are computed as
 *     UTC instants (frozen clock near Almaty midnight — a payment at the
 *     Almaty-local day border is attributed to the right calendar period).
 *   - summary overdue: sourced via aggregateOverdue(today) — by due_date,
 *     NOT by status (decision §0#4 lives in the repo SQL; the service just
 *     passes the Almaty `today`).
 *   - payments-overview: buckets + by_provider passthrough; to<from → 400.
 *   - attendance-today: last-event-wins mapping + group filter passthrough +
 *     date default (Asia/Almaty today).
 *
 * Test names: `it('returns ...')` / `it('throws ...')` / `it('rejects ...')`
 * — NO `it('should ...')` (CLAUDE.md §7).
 */
import { BadRequestException } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { Child } from '@/modules/child/domain/entities/child.entity';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { Enrollment } from '@/modules/enrollment/domain/entities/enrollment.entity';
import {
  EnrollmentListFilter,
  EnrollmentListResult,
  EnrollmentRepository,
} from '@/modules/enrollment/infrastructure/persistence/enrollment.repository';
import { Invoice } from '@/modules/billing/domain/entities/invoice.entity';
import {
  InvoiceRepository,
  ListInvoicesFilter,
} from '@/modules/billing/infrastructure/persistence/invoice.repository';
import { Payment } from '@/modules/billing/domain/entities/payment.entity';
import {
  ListPaymentsFilter,
  PaymentRepository,
} from '@/modules/billing/infrastructure/persistence/payment.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { AttendanceEvent } from '@/modules/attendance/domain/entities/attendance-event.entity';
import {
  AttendanceEventRepository,
  ListAttendanceEventsByChildFilter,
  ListAttendanceEventsByGroupFilter,
  ListAttendanceEventsByKindergartenFilter,
} from '@/modules/attendance/infrastructure/persistence/attendance-event.repository';
import { ChildDailyStatus } from '@/modules/attendance/domain/entities/child-daily-status.entity';
import {
  ChildDailyStatusRepository,
  ListDailyStatusFilter,
} from '@/modules/attendance/infrastructure/persistence/child-daily-status.repository';
import { DashboardService } from './dashboard.service';

const KG = 'k1111111-1111-1111-1111-111111111111';

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
  set(d: Date): void {
    this.fixed = d;
  }
}

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeChildRepo extends ChildRepository {
  activeByKg = new Map<string, number>();
  create(_c: Child): Promise<void> {
    return Promise.resolve();
  }
  findById(_kg: string, _id: string): Promise<Child | null> {
    return Promise.resolve(null);
  }
  findByKindergartenAndIin(_kg: string, _iin: string): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(_c: Child): Promise<void> {
    return Promise.resolve();
  }
  list(
    _kg: string,
    _f: ChildListFilters,
    _p: PageRequest,
  ): Promise<PageResult<Child>> {
    return Promise.resolve({ items: [], total: 0 });
  }
  countActiveByGroup(_kg: string, _gid: string): Promise<number> {
    return Promise.resolve(0);
  }
  recordGroupTransfer(): Promise<void> {
    return Promise.resolve();
  }
  listGroupHistory(): Promise<ChildGroupHistoryRecord[]> {
    return Promise.resolve([]);
  }
  findByIinCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
  findByIdsCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
  // B-DASH override
  countActiveByKindergarten(kg: string): Promise<number> {
    return Promise.resolve(this.activeByKg.get(kg) ?? 0);
  }
}

class FakeEnrollmentRepo extends EnrollmentRepository {
  inProcessingByKg = new Map<string, number>();
  create(_kg: string, e: Enrollment): Promise<Enrollment> {
    return Promise.resolve(e);
  }
  findById(_kg: string, _id: string): Promise<Enrollment | null> {
    return Promise.resolve(null);
  }
  update(_kg: string, e: Enrollment): Promise<Enrollment> {
    return Promise.resolve(e);
  }
  updateWithExpectedStatus(): Promise<boolean> {
    return Promise.resolve(true);
  }
  list(_kg: string, _f: EnrollmentListFilter): Promise<EnrollmentListResult> {
    return Promise.resolve({ items: [], total: 0 });
  }
  // B-DASH override
  countInProcessing(kg: string): Promise<number> {
    return Promise.resolve(this.inProcessingByKg.get(kg) ?? 0);
  }
}

class FakeInvoiceRepo extends InvoiceRepository {
  overdue = { count: 0, amount: 0 };
  overdueTodayArg: string | null = null;
  statusBuckets: {
    paid: { count: number; amount: number };
    pending: { count: number; amount: number };
    overdue: { count: number; amount: number };
    refunded: { count: number; amount: number };
  } = {
    paid: { count: 0, amount: 0 },
    pending: { count: 0, amount: 0 },
    overdue: { count: 0, amount: 0 },
    refunded: { count: 0, amount: 0 },
  };
  statusBetweenArgs: { from: string; to: string; today: string } | null = null;
  create(i: Invoice): Promise<Invoice> {
    return Promise.resolve(i);
  }
  findById(_kg: string, _id: string): Promise<Invoice | null> {
    return Promise.resolve(null);
  }
  list(_kg: string, _f: ListInvoicesFilter): Promise<Invoice[]> {
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
  // B-DASH overrides
  aggregateOverdue(
    _kg: string,
    today: string,
  ): Promise<{ count: number; amount: number }> {
    this.overdueTodayArg = today;
    return Promise.resolve(this.overdue);
  }
  aggregateByStatusBetween(
    _kg: string,
    fromIso: string,
    toIso: string,
    today: string,
  ): Promise<{
    paid: { count: number; amount: number };
    pending: { count: number; amount: number };
    overdue: { count: number; amount: number };
    refunded: { count: number; amount: number };
  }> {
    this.statusBetweenArgs = { from: fromIso, to: toIso, today };
    return Promise.resolve(this.statusBuckets);
  }
}

class FakePaymentRepo extends PaymentRepository {
  sumCalls: Array<{ kg: string; from: string; to: string }> = [];
  sumReturns: number[] = [];
  providerRows: Array<{ provider: string; count: number; amount: number }> = [];
  providerArgs: { from: string; to: string } | null = null;
  acquirePaymentAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
  create(p: Payment): Promise<Payment> {
    return Promise.resolve(p);
  }
  findById(_kg: string, _id: string): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  findByIdempotencyKey(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  findByInvoiceId(): Promise<Payment[]> {
    return Promise.resolve([]);
  }
  list(_kg: string, _f?: ListPaymentsFilter): Promise<Payment[]> {
    return Promise.resolve([]);
  }
  findByProviderTxnIdCrossTenant(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  markCompletedConditional(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  markFailedConditional(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  markProcessingConditional(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  markRefundedConditional(): Promise<Payment | null> {
    return Promise.resolve(null);
  }
  // B-DASH overrides
  sumCompletedBetween(
    kg: string,
    fromIso: string,
    toIsoExclusive: string,
  ): Promise<number> {
    this.sumCalls.push({ kg, from: fromIso, to: toIsoExclusive });
    return Promise.resolve(this.sumReturns[this.sumCalls.length - 1] ?? 0);
  }
  aggregateByProviderBetween(
    _kg: string,
    fromIso: string,
    toIso: string,
  ): Promise<Array<{ provider: string; count: number; amount: number }>> {
    this.providerArgs = { from: fromIso, to: toIso };
    return Promise.resolve(this.providerRows);
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  activeByKg = new Map<string, number>();
  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    throw new Error('not used');
  }
  findById(_kg: string, _id: string): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  findActiveByUserAndKindergarten(): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  findByUserAndKindergarten(): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  listByKindergarten(
    _kg: string,
    _f?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  save(s: StaffMember): Promise<StaffMember> {
    return Promise.resolve(s);
  }
  deactivateAllByKindergarten(): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
  // B-DASH override
  countActive(kg: string): Promise<number> {
    return Promise.resolve(this.activeByKg.get(kg) ?? 0);
  }
}

class FakeGroupRepo extends GroupRepository {
  activeByKg = new Map<string, number>();
  create(_kg: string, _i: CreateGroupInput): Promise<Group> {
    throw new Error('not used');
  }
  findById(_kg: string, _id: string): Promise<Group | null> {
    return Promise.resolve(null);
  }
  list(_kg: string, _f?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve([]);
  }
  update(
    _kg: string,
    _id: string,
    _p: UpdateGroupInput,
  ): Promise<Group | null> {
    return Promise.resolve(null);
  }
  save(g: Group): Promise<Group> {
    return Promise.resolve(g);
  }
  assignMentor(): Promise<GroupMentor> {
    throw new Error('not used');
  }
  unassignMentor(): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  unassignMentorByStaffMember(): Promise<number> {
    return Promise.resolve(0);
  }
  findActiveMentor(): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  listMentorHistory(): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
  findActiveMentorAssignmentsByUserIdCrossTenant(): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
  // B-DASH override
  countActive(kg: string): Promise<number> {
    return Promise.resolve(this.activeByKg.get(kg) ?? 0);
  }
}

class FakeAttendanceEventRepo extends AttendanceEventRepository {
  buckets = { inKindergarten: 0, checkedOut: 0 };
  args: {
    dayStartIso: string;
    dayEndExclusiveIso: string;
    groupId?: string;
  } | null = null;
  create(_kg: string, e: AttendanceEvent): Promise<AttendanceEvent> {
    return Promise.resolve(e);
  }
  findById(): Promise<AttendanceEvent | null> {
    return Promise.resolve(null);
  }
  update(_kg: string, e: AttendanceEvent): Promise<AttendanceEvent> {
    return Promise.resolve(e);
  }
  listByChild(
    _kg: string,
    _cid: string,
    _f: ListAttendanceEventsByChildFilter,
  ): Promise<AttendanceEvent[]> {
    return Promise.resolve([]);
  }
  listByGroup(
    _kg: string,
    _f: ListAttendanceEventsByGroupFilter,
  ): Promise<AttendanceEvent[]> {
    return Promise.resolve([]);
  }
  listByKindergarten(
    _kg: string,
    _f: ListAttendanceEventsByKindergartenFilter,
  ): Promise<AttendanceEvent[]> {
    return Promise.resolve([]);
  }
  // B-DASH override
  lastEventBucketsForDate(
    _kg: string,
    dayStartIso: string,
    dayEndExclusiveIso: string,
    groupId?: string,
  ): Promise<{ inKindergarten: number; checkedOut: number }> {
    this.args = { dayStartIso, dayEndExclusiveIso, groupId };
    return Promise.resolve(this.buckets);
  }
}

class FakeDailyStatusRepo extends ChildDailyStatusRepository {
  statusCounts: Record<string, number> = {};
  args: {
    date: string;
    dayStartIso: string;
    dayEndExclusiveIso: string;
    groupId?: string;
  } | null = null;
  findByChildAndDate(): Promise<ChildDailyStatus | null> {
    return Promise.resolve(null);
  }
  upsert(_kg: string, d: ChildDailyStatus): Promise<ChildDailyStatus> {
    return Promise.resolve(d);
  }
  save(_kg: string, d: ChildDailyStatus): Promise<ChildDailyStatus> {
    return Promise.resolve(d);
  }
  updatePresentIfAbsentOrLate(): Promise<{
    updated: boolean;
    current: ChildDailyStatus | null;
  }> {
    return Promise.resolve({ updated: false, current: null });
  }
  list(_kg: string, _f: ListDailyStatusFilter): Promise<ChildDailyStatus[]> {
    return Promise.resolve([]);
  }
  // B-DASH override
  countByStatusForDate(
    _kg: string,
    date: string,
    dayStartIso: string,
    dayEndExclusiveIso: string,
    groupId?: string,
  ): Promise<Record<string, number>> {
    this.args = { date, dayStartIso, dayEndExclusiveIso, groupId };
    return Promise.resolve(this.statusCounts);
  }
}

interface Harness {
  service: DashboardService;
  clock: FixedClock;
  child: FakeChildRepo;
  enrollment: FakeEnrollmentRepo;
  invoice: FakeInvoiceRepo;
  payment: FakePaymentRepo;
  staff: FakeStaffRepo;
  group: FakeGroupRepo;
  event: FakeAttendanceEventRepo;
  daily: FakeDailyStatusRepo;
}

function makeService(now: Date): Harness {
  const clock = new FixedClock(now);
  const child = new FakeChildRepo();
  const enrollment = new FakeEnrollmentRepo();
  const invoice = new FakeInvoiceRepo();
  const payment = new FakePaymentRepo();
  const staff = new FakeStaffRepo();
  const group = new FakeGroupRepo();
  const event = new FakeAttendanceEventRepo();
  const daily = new FakeDailyStatusRepo();
  const service = new DashboardService(
    clock,
    child,
    enrollment,
    invoice,
    payment,
    staff,
    group,
    event,
    daily,
  );
  return {
    service,
    clock,
    child,
    enrollment,
    invoice,
    payment,
    staff,
    group,
    event,
    daily,
  };
}

// ── summary ──────────────────────────────────────────────────────────────

describe('DashboardService.getSummary', () => {
  it('returns each KPI field composed from its owning port', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    h.child.activeByKg.set(KG, 128);
    h.enrollment.inProcessingByKg.set(KG, 9);
    h.invoice.overdue = { count: 4, amount: 320000 };
    h.payment.sumReturns = [1850000, 14200000]; // MTD then YTD
    h.staff.activeByKg.set(KG, 23);
    h.group.activeByKg.set(KG, 8);

    const res = await h.service.getSummary(KG);

    expect(res).toEqual({
      active_children: 128,
      enrollments_in_processing: 9,
      invoices_overdue_count: 4,
      invoices_overdue_amount: 320000,
      mtd_revenue: 1850000,
      ytd_revenue: 14200000,
      active_staff: 23,
      active_groups: 8,
    });
  });

  it('returns all zeros for an empty kindergarten', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    const res = await h.service.getSummary(KG);
    expect(res).toEqual({
      active_children: 0,
      enrollments_in_processing: 0,
      invoices_overdue_count: 0,
      invoices_overdue_amount: 0,
      mtd_revenue: 0,
      ytd_revenue: 0,
      active_staff: 0,
      active_groups: 0,
    });
  });

  it('passes the Asia/Almaty calendar today to aggregateOverdue (by due_date, not status)', async () => {
    // 18:30 UTC on 2026-05-31 = 23:30 Almaty (UTC+5) — still May 31 local.
    const h = makeService(new Date('2026-05-31T18:30:00.000Z'));
    await h.service.getSummary(KG);
    expect(h.invoice.overdueTodayArg).toBe('2026-05-31');
  });

  it('rolls today to the next Almaty day once UTC crosses the local midnight', async () => {
    // 19:00 UTC on 2026-05-31 = 00:00 Almaty on 2026-06-01.
    const h = makeService(new Date('2026-05-31T19:00:00.000Z'));
    await h.service.getSummary(KG);
    expect(h.invoice.overdueTodayArg).toBe('2026-06-01');
  });

  it('computes MTD/YTD revenue bounds as Almaty-local period starts in UTC', async () => {
    // 20:30 UTC 2026-05-31 = 01:30 Almaty 2026-06-01 → June / 2026.
    const now = new Date('2026-05-31T20:30:00.000Z');
    const h = makeService(now);
    await h.service.getSummary(KG);

    expect(h.payment.sumCalls).toHaveLength(2);
    // MTD: Almaty June-1 00:00 = UTC May-31 19:00.
    expect(h.payment.sumCalls[0].from).toBe('2026-05-31T19:00:00.000Z');
    expect(h.payment.sumCalls[0].to).toBe(now.toISOString());
    // YTD: Almaty Jan-1-2026 00:00 = UTC Dec-31-2025 19:00.
    expect(h.payment.sumCalls[1].from).toBe('2025-12-31T19:00:00.000Z');
    expect(h.payment.sumCalls[1].to).toBe(now.toISOString());
  });

  it('keeps MTD revenue in the prior month when the clock is just before Almaty midnight', async () => {
    // 18:59 UTC 2026-05-31 = 23:59 Almaty 2026-05-31 → still May.
    const now = new Date('2026-05-31T18:59:00.000Z');
    const h = makeService(now);
    await h.service.getSummary(KG);
    // Almaty May-1 00:00 = UTC Apr-30 19:00.
    expect(h.payment.sumCalls[0].from).toBe('2026-04-30T19:00:00.000Z');
  });
});

// ── payments-overview ────────────────────────────────────────────────────

describe('DashboardService.getPaymentsOverview', () => {
  it('returns invoice buckets and provider breakdown composed from each port', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    h.invoice.statusBuckets = {
      paid: { count: 96, amount: 1850000 },
      pending: { count: 14, amount: 260000 },
      overdue: { count: 4, amount: 320000 },
      refunded: { count: 2, amount: 38000 },
    };
    h.payment.providerRows = [
      { provider: 'halyk_epay', count: 16, amount: 250000 },
      { provider: 'kaspi_pay', count: 80, amount: 1600000 },
    ];

    const res = await h.service.getPaymentsOverview(KG, {
      from: '2026-05-01',
      to: '2026-05-31',
    });

    expect(res).toEqual({
      paid: { count: 96, amount: 1850000 },
      pending: { count: 14, amount: 260000 },
      overdue: { count: 4, amount: 320000 },
      refunded: { count: 2, amount: 38000 },
      by_provider: [
        { provider: 'halyk_epay', count: 16, amount: 250000 },
        { provider: 'kaspi_pay', count: 80, amount: 1600000 },
      ],
    });
  });

  it('rejects to < from with BadRequestException invalid_date_range', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    await expect(
      h.service.getPaymentsOverview(KG, {
        from: '2026-05-31',
        to: '2026-05-01',
      }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      h.service.getPaymentsOverview(KG, {
        from: '2026-05-31',
        to: '2026-05-01',
      }),
    ).rejects.toThrow('invalid_date_range');
  });

  it('accepts an equal from/to single-day range (to === from is valid)', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    await expect(
      h.service.getPaymentsOverview(KG, {
        from: '2026-05-18',
        to: '2026-05-18',
      }),
    ).resolves.toBeDefined();
  });

  it('passes raw dates + Almaty today to invoice buckets and an Almaty-day instant window to provider breakdown', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    await h.service.getPaymentsOverview(KG, {
      from: '2026-05-01',
      to: '2026-05-31',
    });

    // Buckets: raw calendar from/to + Asia/Almaty `today`.
    expect(h.invoice.statusBetweenArgs).toEqual({
      from: '2026-05-01',
      to: '2026-05-31',
      today: '2026-05-18',
    });
    // Provider window: [from 00:00 Almaty, (to+1d) 00:00 Almaty) in UTC.
    // Almaty 2026-05-01 00:00 = UTC 2026-04-30T19:00:00Z.
    // Almaty 2026-06-01 00:00 = UTC 2026-05-31T19:00:00Z.
    expect(h.payment.providerArgs).toEqual({
      from: '2026-04-30T19:00:00.000Z',
      to: '2026-05-31T19:00:00.000Z',
    });
  });
});

// ── attendance-today ─────────────────────────────────────────────────────

describe('DashboardService.getAttendanceToday', () => {
  it('returns the 5-bucket aggregate mapped from event + daily-status ports', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    h.event.buckets = { inKindergarten: 42, checkedOut: 7 };
    h.daily.statusCounts = {
      absent: 5,
      on_vacation: 3,
      sick: 2,
      present: 40,
    };

    const res = await h.service.getAttendanceToday(KG, {});

    expect(res).toEqual({
      in_kindergarten: 42,
      checked_out: 7,
      absent: 5,
      on_vacation: 3,
      sick: 2,
    });
  });

  it('returns zeros when no events and no daily-status rows exist', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    const res = await h.service.getAttendanceToday(KG, {});
    expect(res).toEqual({
      in_kindergarten: 0,
      checked_out: 0,
      absent: 0,
      on_vacation: 0,
      sick: 0,
    });
  });

  it('defaults the date to Asia/Almaty today and derives the day instant window', async () => {
    // 20:00 UTC 2026-05-18 = 01:00 Almaty 2026-05-19.
    const h = makeService(new Date('2026-05-18T20:00:00.000Z'));
    await h.service.getAttendanceToday(KG, {});

    expect(h.daily.args).toEqual({
      date: '2026-05-19',
      dayStartIso: '2026-05-18T19:00:00.000Z', // Almaty 2026-05-19 00:00
      dayEndExclusiveIso: '2026-05-19T19:00:00.000Z', // Almaty 2026-05-20 00:00
      groupId: undefined,
    });
    expect(h.event.args).toEqual({
      dayStartIso: '2026-05-18T19:00:00.000Z',
      dayEndExclusiveIso: '2026-05-19T19:00:00.000Z',
      groupId: undefined,
    });
  });

  it('honours an explicit date override and propagates the group filter', async () => {
    const h = makeService(new Date('2026-05-18T06:00:00.000Z'));
    const groupId = 'a1b2c3d4-0000-0000-0000-000000000001';

    await h.service.getAttendanceToday(KG, { date: '2026-04-10', groupId });

    expect(h.daily.args).toEqual({
      date: '2026-04-10',
      dayStartIso: '2026-04-09T19:00:00.000Z',
      dayEndExclusiveIso: '2026-04-10T19:00:00.000Z',
      groupId,
    });
    expect(h.event.args).toEqual({
      dayStartIso: '2026-04-09T19:00:00.000Z',
      dayEndExclusiveIso: '2026-04-10T19:00:00.000Z',
      groupId,
    });
  });
});
