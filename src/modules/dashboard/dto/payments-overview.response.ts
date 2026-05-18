import { ApiProperty } from '@nestjs/swagger';

/**
 * One status bucket. Buckets are computed over INVOICES (amount_after_discount),
 * not payments — invoices carry the pending/overdue/refunded lifecycle the
 * dashboard donut needs. Documented assumption (see DASHBOARD_BACKEND_PLAN §2.2,
 * §8) — surfaced in the PR for frontend sign-off.
 */
export class PaymentBucketDto {
  @ApiProperty({ example: 96, description: 'Invoice count in this bucket.' })
  count!: number;

  @ApiProperty({
    example: 1850000,
    description: 'Sum of amount_after_discount over the bucket (₸).',
  })
  amount!: number;
}

/**
 * One provider row. Provider breakdown is computed over PAYMENTS (only
 * payments carry `provider`): status='completed', paid_at ∈ [from,to].
 */
export class ProviderRowDto {
  @ApiProperty({
    example: 'kaspi_pay',
    description:
      "Payment provider — one of 'mock','halyk_epay','kaspi_pay','tiptoppay','freedom_pay','cash'.",
  })
  provider!: string;

  @ApiProperty({ example: 80, description: 'Completed payment count.' })
  count!: number;

  @ApiProperty({
    example: 1600000,
    description: 'Sum of payment amount for this provider (₸).',
  })
  amount!: number;
}

export class PaymentsOverviewResponseDto {
  @ApiProperty({
    type: PaymentBucketDto,
    description: "Invoices with status = 'paid'.",
  })
  paid!: PaymentBucketDto;

  @ApiProperty({
    type: PaymentBucketDto,
    description:
      "Invoices with status IN ('pending','partial') AND NOT overdue (due_date >= today).",
  })
  pending!: PaymentBucketDto;

  @ApiProperty({
    type: PaymentBucketDto,
    description:
      "Invoices with due_date < today (Asia/Almaty) AND status IN ('pending','partial').",
  })
  overdue!: PaymentBucketDto;

  @ApiProperty({
    type: PaymentBucketDto,
    description: "Invoices with status = 'refunded'.",
  })
  refunded!: PaymentBucketDto;

  @ApiProperty({
    type: [ProviderRowDto],
    description:
      'Completed-payment breakdown by provider over [from,to] (by paid_at).',
  })
  by_provider!: ProviderRowDto[];
}
