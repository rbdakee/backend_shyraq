import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  InvoiceStatus,
  InvoiceType,
} from '../domain/entities/invoice.entity';

const INVOICE_STATUSES: InvoiceStatus[] = [
  'pending',
  'partial',
  'paid',
  'overdue',
  'refunded',
  'cancelled',
];

const INVOICE_TYPES: InvoiceType[] = [
  'monthly',
  'prepayment_3m',
  'prepayment_6m',
  'prepayment_12m',
  'prepayment_24m',
  'additional_service',
  'late_pickup_fee',
  'other',
];

// ── nested DTOs ────────────────────────────────────────────────────────────

class CreateLineItemDto {
  @ApiProperty({
    example: 'Дополнительное занятие — логопед',
    description: 'Line item description.',
  })
  @IsString()
  description!: string;

  @ApiProperty({
    example: 1,
    description: 'Quantity (must be > 0).',
    minimum: 1,
  })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({
    example: 15000,
    description: 'Unit price in KZT.',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  unit_price!: number;

  @ApiProperty({
    example: 'f1a2b3c4-0001-0001-0001-000000000001',
    description: 'Optional link to a tariff plan.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  tariff_plan_id?: string | null;
}

// ── request DTOs ───────────────────────────────────────────────────────────

export class CreateInvoiceOneOffDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({
    enum: INVOICE_TYPES,
    example: 'additional_service',
    description: 'Type of one-off invoice.',
  })
  @IsEnum(INVOICE_TYPES)
  invoice_type!: InvoiceType;

  @ApiProperty({
    example: 30000,
    description: 'Gross amount in KZT before discount.',
    minimum: 0,
  })
  @IsNumber()
  @Min(0)
  amount_due!: number;

  @ApiProperty({
    example: '2026-06-25',
    description: 'ISO date (YYYY-MM-DD) by which payment is expected.',
  })
  @IsDateString()
  due_date!: string;

  @ApiProperty({
    example: '2026-06-01',
    description: 'Billing period start ISO date.',
  })
  @IsDateString()
  period_start!: string;

  @ApiProperty({
    example: '2026-06-30',
    description: 'Billing period end ISO date.',
  })
  @IsDateString()
  period_end!: string;

  @ApiProperty({
    example: 'Дополнительные занятия — июнь 2026',
    description: 'Free-text invoice description.',
    required: false,
    nullable: true,
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiProperty({
    example: 10,
    description: 'Discount percentage to apply (0–100).',
    required: false,
    nullable: true,
    minimum: 0,
    maximum: 100,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discount_pct?: number | null;

  @ApiProperty({
    example: 'Скидка за досрочную оплату',
    required: false,
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  discount_reason?: string | null;

  @ApiProperty({
    type: [CreateLineItemDto],
    description:
      'Optional line items breakdown. If omitted a single item is synthesised from amount_due.',
    required: false,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateLineItemDto)
  line_items?: CreateLineItemDto[];
}

export class ManualMarkPaidInvoiceDto {
  @ApiProperty({
    example: '2026-06-10T12:00:00.000Z',
    description:
      'ISO timestamp of cash payment. Defaults to server time when omitted.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  paid_at?: string | null;

  @ApiProperty({
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    description: 'User who paid. Defaults to req.user.id when omitted.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  payer_user_id?: string | null;

  @ApiProperty({
    example: 'Оплачено наличными в кассе',
    description: 'Admin note attached to the cash payment record.',
    required: false,
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

export class CancelInvoiceDto {
  @ApiProperty({
    example: 'Ошибочное начисление',
    description: 'Optional reason for cancellation stored in description.',
    required: false,
    nullable: true,
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

// ── query DTOs ─────────────────────────────────────────────────────────────

export class ListInvoicesQueryDto {
  @ApiProperty({
    enum: INVOICE_STATUSES,
    example: 'pending',
    description: 'Filter by invoice status.',
    required: false,
  })
  @IsOptional()
  @IsEnum(INVOICE_STATUSES)
  status?: InvoiceStatus;

  @ApiProperty({
    example: '2026-06-01',
    description: 'Return invoices with due_date on or after this date.',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  due_date_from?: string;

  @ApiProperty({
    example: '2026-06-30',
    description: 'Return invoices with due_date on or before this date.',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  due_date_to?: string;

  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'Filter by child.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  child_id?: string;

  @ApiProperty({
    enum: INVOICE_TYPES,
    example: 'monthly',
    description: 'Filter by invoice type.',
    required: false,
  })
  @IsOptional()
  @IsEnum(INVOICE_TYPES)
  invoice_type?: InvoiceType;

  @ApiProperty({
    example: '2026-06-01',
    description: 'Filter invoices whose period_start >= this date.',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  period_start?: string;

  @ApiProperty({
    example: '2026-06-30',
    description: 'Filter invoices whose period_end <= this date.',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  period_end?: string;

  @ApiProperty({
    example: 'eyJpZCI6InV1aWQifQ==',
    description:
      'Pagination cursor from previous response next_cursor. Pass back to get next page.',
    required: false,
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({
    example: 50,
    description: 'Page size (default 50, max 200).',
    required: false,
    minimum: 1,
    maximum: 200,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  @Type(() => Number)
  limit?: number;
}

// ── response DTOs ──────────────────────────────────────────────────────────

export class InvoiceLineItemResponseDto {
  @ApiProperty({ example: 'l1a2b3c4-0004-0004-0004-000000000004' })
  id!: string;

  @ApiProperty({ example: 'i1a2b3c4-0005-0005-0005-000000000005' })
  invoice_id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'Ежемесячная плата — июнь 2026' })
  description!: string;

  @ApiProperty({
    example: 'f1a2b3c4-0001-0001-0001-000000000001',
    nullable: true,
  })
  tariff_plan_id!: string | null;

  @ApiProperty({ example: 1 })
  quantity!: number;

  @ApiProperty({ example: 120000 })
  unit_price!: number;

  @ApiProperty({ example: 120000 })
  line_total!: number;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;
}

export class InvoiceResponseDto {
  @ApiProperty({ example: 'i1a2b3c4-0005-0005-0005-000000000005' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({ example: 'p1a2b3c4-0006-0006-0006-000000000006' })
  payment_account_id!: string;

  @ApiProperty({
    example: 'f1a2b3c4-0001-0001-0001-000000000001',
    nullable: true,
    description:
      'Tariff plan used during generation. Null for manual invoices.',
  })
  tariff_plan_id!: string | null;

  @ApiProperty({ enum: INVOICE_TYPES, example: 'monthly' })
  invoice_type!: InvoiceType;

  @ApiProperty({
    example: '2026-06-01',
    description: 'Billing period start (ISO date YYYY-MM-DD).',
  })
  period_start!: string;

  @ApiProperty({
    example: '2026-06-30',
    description: 'Billing period end (ISO date YYYY-MM-DD).',
  })
  period_end!: string;

  @ApiProperty({ example: 120000, description: 'Gross amount in KZT.' })
  amount_due!: number;

  @ApiProperty({
    example: 10,
    nullable: true,
    description: 'Discount percentage applied.',
  })
  discount_pct!: number | null;

  @ApiProperty({
    example: 'Скидка многодетной семье',
    nullable: true,
  })
  discount_reason!: string | null;

  @ApiProperty({
    example: 108000,
    description: 'Net amount after discount in KZT.',
  })
  amount_after_discount!: number;

  @ApiProperty({ enum: INVOICE_STATUSES, example: 'pending' })
  status!: InvoiceStatus;

  @ApiProperty({
    example: '2026-06-25',
    description: 'Due date ISO date (YYYY-MM-DD).',
  })
  due_date!: string;

  @ApiProperty({
    example: 'Ежемесячная плата за июнь 2026',
    nullable: true,
  })
  description!: string | null;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Number of days when invoice was prorated.',
  })
  prorated_for_days!: number | null;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  updated_at!: string;

  @ApiProperty({
    type: [InvoiceLineItemResponseDto],
    description: 'Line items — populated only on GET /admin/invoices/:id.',
    required: false,
  })
  line_items?: InvoiceLineItemResponseDto[];
}

// ── payment calendar ───────────────────────────────────────────────────────

class PaymentCalendarMonthDto {
  @ApiProperty({
    example: '2026-06-01',
    description: 'Period start as ISO date (first day of the month).',
  })
  period_start!: string;

  @ApiProperty({
    example: '2026-06-30',
    description: 'Period end as ISO date (last day of the month).',
  })
  period_end!: string;

  @ApiProperty({
    example: 'i1a2b3c4-0005-0005-0005-000000000005',
    nullable: true,
    description: 'Invoice id if already generated for this period.',
  })
  invoice_id!: string | null;

  @ApiProperty({
    example: 'projected',
    enum: [
      'pending',
      'paid',
      'overdue',
      'partial',
      'projected',
      'refunded',
      'cancelled',
    ],
    description:
      'Current status. "projected" means no invoice exists yet — amount is estimated.',
  })
  projected_status!:
    | 'pending'
    | 'paid'
    | 'overdue'
    | 'partial'
    | 'projected'
    | 'refunded'
    | 'cancelled';

  @ApiProperty({
    example: 108000,
    nullable: true,
    description:
      'Net amount after discount in KZT. Null if projection unavailable.',
  })
  amount_after_discount!: number | null;

  @ApiProperty({
    example: '2026-06-25',
    nullable: true,
    description: 'Due date (ISO date YYYY-MM-DD). Null for projections.',
  })
  due_date!: string | null;

  @ApiProperty({
    example: false,
    description: 'True when this month is a pure projection (no invoice yet).',
  })
  is_projection!: boolean;

  @ApiProperty({
    example: 2,
    description:
      'Number of public/non-billable holidays in this period (used for pro-rata display).',
  })
  holidays_affected!: number;
}

export class PaymentCalendarResponseDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({
    example: 12,
    description: 'Number of months included in this calendar view.',
  })
  months_ahead!: number;

  @ApiProperty({
    type: [PaymentCalendarMonthDto],
    description: 'One entry per month in the calendar window.',
  })
  invoices!: PaymentCalendarMonthDto[];
}

export class ListInvoicesResponseDto {
  @ApiProperty({ type: [InvoiceResponseDto] })
  items!: InvoiceResponseDto[];

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Cursor for next page. Null on last page.',
  })
  next_cursor!: string | null;
}
