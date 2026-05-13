import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * One row of the per-child status-history audit (B22a T9).
 * Wire-shape is snake_case per `docs/endpoints.md` §2.7.4.
 */
export class ChildStatusHistoryDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440099' })
  id!: string;

  @ApiProperty({
    enum: ['card_created', 'active', 'archived'],
    example: 'active',
  })
  previous_status!: 'card_created' | 'active' | 'archived';

  @ApiProperty({
    enum: ['card_created', 'active', 'archived'],
    example: 'archived',
  })
  new_status!: 'card_created' | 'active' | 'archived';

  @ApiProperty({
    nullable: true,
    description:
      'Captured BEFORE Child.reactivate clears archive_reason on the children row. Populated for archived→active rows.',
    example: 'Family relocated',
  })
  previous_archive_reason!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Set when new_status=archived. NULL otherwise.',
    example: 'Family relocated',
  })
  archive_reason!: string | null;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440007',
    description: 'users.id of the actor (req.user.sub), not staff_members.id.',
  })
  changed_by_user_id!: string;

  @ApiProperty({ example: '2026-05-12T14:30:00.000Z' })
  changed_at!: string;
}

export class ChildStatusHistoryListResponseDto {
  @ApiProperty({ type: [ChildStatusHistoryDto] })
  items!: ChildStatusHistoryDto[];

  @ApiProperty({ example: 2 })
  total!: number;
}

export class ListChildStatusHistoryQueryDto {
  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(0)
  offset?: number;
}
