import { BadRequestException, Injectable } from '@nestjs/common';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { EnrollmentRepository } from '@/modules/enrollment/infrastructure/persistence/enrollment.repository';
import { InvoiceRepository } from '@/modules/billing/infrastructure/persistence/invoice.repository';
import { PaymentRepository } from '@/modules/billing/infrastructure/persistence/payment.repository';
import { RefundRepository } from '@/modules/billing/infrastructure/persistence/refund.repository';
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
    private readonly refundRepo: RefundRepository,
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

  // Phase A scaffold — real bodies land in phases B/C/D.

  async getSummary(_kindergartenId: string): Promise<DashboardSummaryResult> {
    return Promise.resolve({
      active_children: 0,
      enrollments_in_processing: 0,
      invoices_overdue_count: 0,
      invoices_overdue_amount: 0,
      mtd_revenue: 0,
      ytd_revenue: 0,
      active_staff: 0,
      active_groups: 0,
    });
  }

  async getPaymentsOverview(
    _kindergartenId: string,
    range: { from: string; to: string },
  ): Promise<PaymentsOverviewResult> {
    if (range.to < range.from) {
      throw new BadRequestException('invalid_date_range');
    }
    const empty: PaymentBucket = { count: 0, amount: 0 };
    return Promise.resolve({
      paid: { ...empty },
      pending: { ...empty },
      overdue: { ...empty },
      refunded: { ...empty },
      by_provider: [],
    });
  }

  async getAttendanceToday(
    _kindergartenId: string,
    _opts: { groupId?: string; date?: string },
  ): Promise<AttendanceTodayResult> {
    return Promise.resolve({
      in_kindergarten: 0,
      checked_out: 0,
      absent: 0,
      on_vacation: 0,
      sick: 0,
    });
  }
}
