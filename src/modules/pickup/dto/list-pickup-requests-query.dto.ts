import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

const PICKUP_REQUEST_STATUSES = [
  'otp_sent',
  'validated',
  'expired',
  'cancelled',
] as const;

type PickupRequestStatusLiteral = (typeof PICKUP_REQUEST_STATUSES)[number];

/**
 * Query params for `GET /staff/pickup-requests`. Both fields are optional;
 * class-validator rejects invalid enum values or non-UUID strings before the
 * service is invoked, preventing raw SQL errors on bad input.
 */
export class ListPickupRequestsQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    example: '33333333-3333-3333-3333-333333333333',
    description: 'Filter by group UUID.',
  })
  @IsOptional()
  @IsUUID()
  groupId?: string;

  @ApiPropertyOptional({
    enum: PICKUP_REQUEST_STATUSES,
    example: 'otp_sent',
    description: 'Filter by pickup request status.',
  })
  @IsOptional()
  @IsEnum(PICKUP_REQUEST_STATUSES)
  status?: PickupRequestStatusLiteral;
}
