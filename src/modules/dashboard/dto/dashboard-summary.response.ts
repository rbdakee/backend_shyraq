import { ApiProperty } from '@nestjs/swagger';

/**
 * GET /admin/dashboard/summary — top-of-dashboard KPI aggregate.
 *
 * Field semantics (locked product decisions, see DASHBOARD_BACKEND_PLAN §0):
 *  - active_children            child.status = 'active'
 *  - enrollments_in_processing  enrollment.status IN ('new','in_processing','waitlist')
 *  - invoices_overdue_*         due_date < today(Asia/Almaty) AND status IN ('pending','partial')
 *  - mtd_revenue / ytd_revenue  GROSS SUM(payments.amount) status='completed',
 *                               paid_at within calendar month/year in Asia/Almaty
 *                               (refunds NOT subtracted — see payments-overview)
 *  - active_staff               staff_member.is_active = true AND archived_at IS NULL
 *  - active_groups              group.archived_at IS NULL
 *
 * All money fields are whole tenge as a plain number (same convention as
 * InvoiceRepository.getPaidSumForInvoice → Number(sum)).
 */
export class DashboardSummaryResponseDto {
  @ApiProperty({
    example: 128,
    description: "Children with status = 'active'.",
  })
  active_children!: number;

  @ApiProperty({
    example: 9,
    description:
      "Enrollments with status IN ('new','in_processing','waitlist').",
  })
  enrollments_in_processing!: number;

  @ApiProperty({
    example: 4,
    description:
      "Invoices with due_date < today (Asia/Almaty) AND status IN ('pending','partial').",
  })
  invoices_overdue_count!: number;

  @ApiProperty({
    example: 320000,
    description: 'Sum of amount_after_discount over the overdue invoices (₸).',
  })
  invoices_overdue_amount!: number;

  @ApiProperty({
    example: 1850000,
    description:
      'Gross completed-payment revenue for the current calendar month (Asia/Almaty), ₸.',
  })
  mtd_revenue!: number;

  @ApiProperty({
    example: 14200000,
    description:
      'Gross completed-payment revenue for the current calendar year (Asia/Almaty), ₸.',
  })
  ytd_revenue!: number;

  @ApiProperty({
    example: 23,
    description: 'Staff members with is_active = true AND archived_at IS NULL.',
  })
  active_staff!: number;

  @ApiProperty({
    example: 8,
    description: 'Groups with archived_at IS NULL.',
  })
  active_groups!: number;
}
