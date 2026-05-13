import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

export class TriggerMonthlyRunDto {
  @ApiProperty({
    example: '00000000-0000-0000-0000-000000000001',
    description:
      'Restrict the run to a single kindergarten. Omit to run for all tenants.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  kindergarten_id?: string | null;

  @ApiProperty({
    example: '2026-06-01',
    description:
      'ISO date (YYYY-MM-DD) of the first day of the billing period. Defaults to the first day of the current month when omitted.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  period_start?: string | null;
}

export class TriggerMonthlyRunResponseDto {
  @ApiProperty({
    example: 'billing:monthly-run:2026-06-01',
    description: 'BullMQ job id (or queue name token) for the enqueued run.',
  })
  job_id!: string;

  @ApiProperty({
    example: 'enqueued',
    description: 'Always "enqueued" on success.',
  })
  status!: 'enqueued';
}

export class TriggerDiscountExpireRunDto {
  @ApiProperty({
    example: '2026-06-01T03:00:00.000Z',
    description:
      'Optional ISO-8601 anchor for the expire pass. Defaults to server now.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  now?: string | null;
}

export class TriggerDiscountExpireRunResponseDto {
  @ApiProperty({
    example: 'billing:discount-expire-manual:1717200000',
    description: 'BullMQ job id for the enqueued discount-expire run.',
  })
  job_id!: string;

  @ApiProperty({
    example: 'enqueued',
    description: 'Always "enqueued" on success.',
  })
  status!: 'enqueued';
}

export class TriggerOverdueRunDto {
  @ApiProperty({
    example: '2026-05-13T03:00:00.000Z',
    description:
      'Optional ISO-8601 anchor for the overdue cut-off. Defaults to server now.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsDateString()
  now?: string | null;
}

export class TriggerOverdueRunResponseDto {
  @ApiProperty({
    example: 'billing:overdue-manual:1717200000',
    description: 'BullMQ job id for the enqueued overdue invoice run.',
  })
  job_id!: string;

  @ApiProperty({
    example: 'enqueued',
    description: 'Always "enqueued" on success.',
  })
  status!: 'enqueued';
}
