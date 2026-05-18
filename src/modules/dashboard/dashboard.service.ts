import { BadRequestException, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { EnrollmentRepository } from '@/modules/enrollment/infrastructure/persistence/enrollment.repository';
import { InvoiceRepository } from '@/modules/billing/infrastructure/persistence/invoice.repository';
import { PaymentRepository } from '@/modules/billing/infrastructure/persistence/payment.repository';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { AttendanceEventRepository } from '@/modules/attendance/infrastructure/persistence/attendance-event.repository';
import { ChildDailyStatusRepository } from '@/modules/attendance/infrastructure/persistence/child-daily-status.repository';

export interface DashboardSummaryResult {
  active_children: number;
  enrollments_in_processing: number;
  invoices_overdue_count: number;
  invoices_overdue_amount: number;
  mtd_revenue: number;
  ytd_revenue: number;
  active_staff: number;
  active_groups: number;
}

export interface PaymentBucket {
  count: number;
  amount: number;
}

export interface ProviderRow {
  provider: string;
  count: number;
  amount: number;
}

export interface PaymentsOverviewResult {
  paid: PaymentBucket;
  pending: PaymentBucket;
  overdue: PaymentBucket;
  refunded: PaymentBucket;
  by_provider: ProviderRow[];
}

export interface AttendanceTodayResult {
  in_kindergarten: number;
  checked_out: number;
  absent: number;
  on_vacation: number;
  sick: number;
}

/**
 * Asia/Almaty calendar boundaries derived from a single ClockPort.now().
 * Almaty is UTC+5 with no DST, so a local civil date is just the UTC instant
 * shifted by +5h; a local midnight is the UTC instant shifted back by −5h.
 */
const ALMATY_OFFSET_MS = 5 * 60 * 60 * 1000;

/**
 * Read-only analytics aggregator (B-DASH). NOT a brocoders aggregate — it owns
 * no table, no migration, no domain entity. It composes already-existing
 * bounded-context ports (each repo method resolves its own tenantStorage
 * EntityManager so RLS stays intact) via Promise.all.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly clock: ClockPort,
    private readonly childRepo: ChildRepository,
    private readonly enrollmentRepo: EnrollmentRepository,
    private readonly invoiceRepo: InvoiceRepository,
    private readonly paymentRepo: PaymentRepository,
    private readonly staffRepo: StaffMemberRepository,
    private readonly groupRepo: GroupRepository,
    private readonly attendanceEventRepo: AttendanceEventRepository,
    private readonly dailyStatusRepo: ChildDailyStatusRepository,
  ) {}

  /**
   * Almaty boundaries: `today` (YYYY-MM-DD local), and the UTC instants of
   * Almaty-local first-of-month / first-of-year midnights (for `paid_at`
   * timestamptz comparisons).
   */
  private almatyBoundaries(): {
    today: string;
    monthStartUtc: Date;
    yearStartUtc: Date;
    nowUtc: Date;
  } {
    const nowUtc = this.clock.now();
    const shifted = new Date(nowUtc.getTime() + ALMATY_OFFSET_MS);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth(); // 0-based
    const d = shifted.getUTCDate();
    const pad = (n: number): string => String(n).padStart(2, '0');
    const today = `${y}-${pad(m + 1)}-${pad(d)}`;
    // Almaty-local midnight expressed as a UTC instant = local 00:00 − 5h.
    const monthStartUtc = new Date(Date.UTC(y, m, 1) - ALMATY_OFFSET_MS);
    const yearStartUtc = new Date(Date.UTC(y, 0, 1) - ALMATY_OFFSET_MS);
    return { today, monthStartUtc, yearStartUtc, nowUtc };
  }

  /**
   * UTC instant of an Asia/Almaty-local midnight for the given calendar date
   * (`YYYY-MM-DD`), optionally offset by whole days. `addDays = 1` on the
   * range `to` yields the exclusive upper bound of an inclusive day range.
   */
  private almatyDayStartUtc(dateStr: string, addDays = 0): Date {
    const [y, m, d] = dateStr.split('-').map((p) => Number(p));
    return new Date(Date.UTC(y, m - 1, d + addDays) - ALMATY_OFFSET_MS);
  }

  async getSummary(kindergartenId: string): Promise<DashboardSummaryResult> {
    const { today, monthStartUtc, yearStartUtc, nowUtc } =
      this.almatyBoundaries();
    const nowIso = nowUtc.toISOString();

    const [
      activeChildren,
      enrollmentsInProcessing,
      overdue,
      mtdRevenue,
      ytdRevenue,
      activeStaff,
      activeGroups,
    ] = await Promise.all([
      this.childRepo.countActiveByKindergarten(kindergartenId),
      this.enrollmentRepo.countInProcessing(kindergartenId),
      this.invoiceRepo.aggregateOverdue(kindergartenId, today),
      this.paymentRepo.sumCompletedBetween(
        kindergartenId,
        monthStartUtc.toISOString(),
        nowIso,
      ),
      this.paymentRepo.sumCompletedBetween(
        kindergartenId,
        yearStartUtc.toISOString(),
        nowIso,
      ),
      this.staffRepo.countActive(kindergartenId),
      this.groupRepo.countActive(kindergartenId),
    ]);

    return {
      active_children: activeChildren,
      enrollments_in_processing: enrollmentsInProcessing,
      invoices_overdue_count: overdue.count,
      invoices_overdue_amount: overdue.amount,
      mtd_revenue: mtdRevenue,
      ytd_revenue: ytdRevenue,
      active_staff: activeStaff,
      active_groups: activeGroups,
    };
  }

  async getPaymentsOverview(
    kindergartenId: string,
    range: { from: string; to: string },
  ): Promise<PaymentsOverviewResult> {
    // YYYY-MM-DD compares lexicographically, so `to < from` is the invalid case.
    if (range.to < range.from) {
      throw new BadRequestException('invalid_date_range');
    }

    const { today } = this.almatyBoundaries();
    // Provider breakdown filters payments.paid_at (timestamptz). The query
    // [from, to] is interpreted as inclusive Asia/Almaty calendar days, so the
    // window is [from 00:00 Almaty, (to + 1d) 00:00 Almaty) in UTC. Buckets
    // filter invoice.period_start (a date column) directly with from/to.
    const fromInstantIso = this.almatyDayStartUtc(range.from).toISOString();
    const toExclusiveInstantIso = this.almatyDayStartUtc(
      range.to,
      1,
    ).toISOString();

    const [buckets, byProvider] = await Promise.all([
      this.invoiceRepo.aggregateByStatusBetween(
        kindergartenId,
        range.from,
        range.to,
        today,
      ),
      this.paymentRepo.aggregateByProviderBetween(
        kindergartenId,
        fromInstantIso,
        toExclusiveInstantIso,
      ),
    ]);

    return {
      paid: buckets.paid,
      pending: buckets.pending,
      overdue: buckets.overdue,
      refunded: buckets.refunded,
      by_provider: byProvider,
    };
  }

  async getAttendanceToday(
    kindergartenId: string,
    opts: { groupId?: string; date?: string },
  ): Promise<AttendanceTodayResult> {
    const { today } = this.almatyBoundaries();
    const date = opts.date ?? today;
    // Almaty calendar day for `date` as a half-open UTC instant window —
    // used for the event last-event window and the absent no-check_in
    // exclusion (§1.3, §2.3).
    const dayStartIso = this.almatyDayStartUtc(date).toISOString();
    const dayEndExclusiveIso = this.almatyDayStartUtc(date, 1).toISOString();

    const [statusCounts, eventBuckets] = await Promise.all([
      this.dailyStatusRepo.countByStatusForDate(
        kindergartenId,
        date,
        dayStartIso,
        dayEndExclusiveIso,
        opts.groupId,
      ),
      this.attendanceEventRepo.lastEventBucketsForDate(
        kindergartenId,
        dayStartIso,
        dayEndExclusiveIso,
        opts.groupId,
      ),
    ]);

    return {
      in_kindergarten: eventBuckets.inKindergarten,
      checked_out: eventBuckets.checkedOut,
      absent: statusCounts['absent'] ?? 0,
      on_vacation: statusCounts['on_vacation'] ?? 0,
      sick: statusCounts['sick'] ?? 0,
    };
  }
}
