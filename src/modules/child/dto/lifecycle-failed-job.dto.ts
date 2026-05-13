import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * One failed BullMQ `lifecycle` queue job, surfaced for admin operator
 * triage (B22a T10 closes B21 T7-L2). Wire shape is snake_case per
 * `docs/endpoints.md` §2.24.
 */
export class LifecycleFailedJobDto {
  @ApiProperty({
    example: '12345',
    description:
      'BullMQ job id (string). Use this in `POST /admin/lifecycle/failed-jobs/:id/retry`.',
  })
  id!: string;

  @ApiProperty({
    example: 'lifecycle:pro-rata-refund',
    description:
      'BullMQ job name. Currently the only job name in the `lifecycle` queue is `lifecycle:pro-rata-refund` (B21).',
  })
  name!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: {
      kindergartenId: '550e8400-e29b-41d4-a716-446655440000',
      childId: '550e8400-e29b-41d4-a716-446655440001',
      archivedAt: '2026-05-12T14:30:00.000Z',
    },
    description:
      'Raw `job.data` snapshot. Per-kg admins only see jobs whose `payload.kindergartenId` matches their own kg.',
  })
  payload!: Record<string, unknown>;

  @ApiProperty({
    nullable: true,
    example: 'ChildNotYetArchivedError: child not yet archived (status=active)',
    description:
      "BullMQ's `failedReason` — the first line of the error thrown by the processor.",
  })
  failed_reason!: string | null;

  @ApiProperty({
    example: 3,
    description:
      'How many times BullMQ tried this job before it landed in failed state. The producer wires `attempts: 3` (1m / 2m / 4m exp-backoff).',
  })
  attempts_made!: number;

  @ApiProperty({
    example: 1747061400000,
    description: 'ms epoch — when the job was originally enqueued.',
  })
  timestamp!: number;

  @ApiProperty({
    nullable: true,
    example: 1747061820000,
    description:
      'ms epoch — when the job moved to its terminal failed state. NULL if BullMQ has not stamped this yet (rare).',
  })
  finished_on!: number | null;
}

export class ListLifecycleFailedJobsResponseDto {
  @ApiProperty({ type: [LifecycleFailedJobDto] })
  items!: LifecycleFailedJobDto[];

  @ApiProperty({
    nullable: true,
    example: 'eyJvZmZzZXQiOjUwfQ==',
    description:
      'Opaque base64 cursor. Pass it as `?cursor=` on the next call. NULL when the queue page is exhausted.',
  })
  next_cursor!: string | null;
}

export class ListFailedLifecycleJobsQueryDto {
  @ApiPropertyOptional({
    default: 50,
    minimum: 1,
    maximum: 200,
    description: 'Page size (BullMQ getFailed window). Capped at 200.',
  })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({
    description:
      'Opaque base64 cursor returned from a prior call. Omit on the first page.',
    example: 'eyJvZmZzZXQiOjUwfQ==',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}

export class RetryLifecycleFailedJobResponseDto {
  @ApiProperty({
    example: true,
    description: 'Always true on success. Indicates the job re-enqueue ran.',
  })
  enqueued!: true;

  @ApiProperty({
    example: '12345',
    description: 'BullMQ job id that was re-enqueued (echo of the path param).',
  })
  job_id!: string;
}
