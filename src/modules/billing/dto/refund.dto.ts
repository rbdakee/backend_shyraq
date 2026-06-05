import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { RefundStatus } from '../domain/entities/refund.entity';

const REFUND_STATUSES: RefundStatus[] = [
  'pending',
  'approved',
  'processed',
  'rejected',
];

export class CreateRefundDto {
  @ApiProperty({
    example: 'pa1b2c3d-0007-0007-0007-000000000007',
    description:
      'Id of the payment to refund. Payment must have status="completed".',
  })
  @IsUUID()
  payment_id!: string;

  @ApiProperty({
    example: 60000,
    description:
      'Amount to refund in KZT. Must be <= payment.amount. Full refunds only in B13.',
    minimum: 1,
  })
  @IsNumber()
  @Min(1)
  amount!: number;

  @ApiProperty({
    example: 'Переплата за июнь 2026',
    description: 'Reason for the refund.',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ApproveRefundDto {
  // Empty body — approver identity is resolved from req.user in the controller.
  // Class kept for Swagger @Body() annotation consistency.
}

export class ProcessRefundDto {
  // Body is OPTIONAL — non-Kaspi refunds (mock/halyk) need no body. The single
  // field gates kaspi_pay refunds only (K9): the Kaspi API has no idempotency
  // key, so the operator must confirm they verified the Kaspi refund/return
  // history before processing, else a blind retry may double-refund.
  @ApiPropertyOptional({
    example: true,
    description:
      'Required ONLY for kaspi_pay refunds. Set true to confirm you verified ' +
      'the refund/return history in the Kaspi app before processing. Kaspi has ' +
      'no idempotency key, so a blind retry may double-refund. Ignored for ' +
      'mock/halyk_epay refunds.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledge_kaspi_history_checked?: boolean;
}

export class RejectRefundDto {
  @ApiProperty({
    example: 'Возврат отклонён — недостаточно оснований',
    description:
      'Rejection note. Overwrites the original reason column (single-column design — see Refund.reject docstring).',
    minLength: 1,
    maxLength: 500,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}

export class ListRefundsQueryDto {
  @ApiProperty({
    enum: REFUND_STATUSES,
    example: 'pending',
    description: 'Filter by refund status.',
    required: false,
  })
  @IsOptional()
  @IsEnum(REFUND_STATUSES)
  status?: RefundStatus;

  @ApiProperty({
    example: 'pa1b2c3d-0007-0007-0007-000000000007',
    description: 'Filter by the original payment.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  payment_id?: string;

  @ApiProperty({
    example: 'eyJpZCI6InV1aWQifQ==',
    description: 'Pagination cursor from previous response.',
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

export class RefundResponseDto {
  @ApiProperty({ example: 'r1a2b3c4-0008-0008-0008-000000000008' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'pa1b2c3d-0007-0007-0007-000000000007' })
  payment_id!: string;

  @ApiProperty({
    example: 'i1a2b3c4-0005-0005-0005-000000000005',
    nullable: true,
    description: 'Invoice linked to this refund (via payment).',
  })
  invoice_id!: string | null;

  @ApiProperty({
    example: 60000,
    description: 'Refund amount in KZT.',
  })
  amount!: number;

  @ApiProperty({
    example: 'Переплата за июнь 2026',
    description:
      'Reason for the refund. For rejected refunds this field stores the rejection note.',
  })
  reason!: string;

  @ApiProperty({ enum: REFUND_STATUSES, example: 'pending' })
  status!: RefundStatus;

  @ApiProperty({
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    nullable: true,
    description: 'Admin who approved/rejected the refund.',
  })
  processed_by!: string | null;

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Provider reference number returned on process.',
  })
  provider_ref!: string | null;

  @ApiProperty({ example: '2026-06-11T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-06-11T10:30:00.000Z' })
  updated_at!: string;
}

export class ApproveRefundResponseDto {
  @ApiProperty({ example: 'r1a2b3c4-0008-0008-0008-000000000008' })
  id!: string;

  @ApiProperty({ example: 'approved' })
  status!: 'approved';

  @ApiProperty({ example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  processed_by!: string;
}

export class ProcessRefundResponseDto {
  @ApiProperty({ example: 'r1a2b3c4-0008-0008-0008-000000000008' })
  id!: string;

  @ApiProperty({ example: 'processed' })
  status!: 'processed';

  @ApiProperty({
    example: 'MOCK-REFUND-0001',
    nullable: true,
    description: 'Provider reference returned by the payment provider.',
  })
  provider_ref!: string | null;
}

export class RefundListResponseDto {
  @ApiProperty({ type: [RefundResponseDto] })
  items!: RefundResponseDto[];

  @ApiProperty({ example: null, nullable: true })
  next_cursor!: string | null;
}
