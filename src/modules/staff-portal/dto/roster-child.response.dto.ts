import { ApiProperty } from '@nestjs/swagger';
import { CHILD_INTRADAY_STATUS_VALUES } from '@/modules/attendance/domain/value-objects/child-intraday-status.vo';

/**
 * One child row in a Staff-App roster / specialist child-picker page. Shared by
 * `GET /staff/my-groups/:groupId/children` and `GET /staff/children`.
 */
export class RosterChildResponseDto {
  @ApiProperty({
    example: 'c3b30bb7-0000-0000-0000-000000000001',
    description: 'Child id.',
  })
  id!: string;

  @ApiProperty({ example: 'Алихан Сериков', description: 'Child full name.' })
  full_name!: string;

  @ApiProperty({
    example: '2020-06-14',
    description: 'Date of birth (YYYY-MM-DD).',
  })
  date_of_birth!: string;

  @ApiProperty({
    example: 'https://cdn.example.com/media/kg/2026-06/abc.jpg',
    nullable: true,
    description: 'Child photo URL (presigned on read), or null.',
  })
  photo_url!: string | null;

  @ApiProperty({
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
    nullable: true,
    description: "The child's current group id, or null.",
  })
  current_group_id!: string | null;

  @ApiProperty({
    example: 'present',
    nullable: true,
    enum: CHILD_INTRADAY_STATUS_VALUES,
    description:
      "Today's child_daily_status (Asia/Almaty), or null when no row exists " +
      'for the current day.',
  })
  day_status!: string | null;
}

/**
 * Cursor-paginated wrapper for a roster / specialist-children page. `items` is
 * the page; `next_cursor` is the opaque token for the next page, or null when
 * this was the last page.
 */
export class RosterPageResponseDto {
  @ApiProperty({ type: [RosterChildResponseDto] })
  items!: RosterChildResponseDto[];

  @ApiProperty({
    example: 'NDA',
    nullable: true,
    description:
      'Opaque cursor for the next page. null when this is the last page ' +
      '(fewer items than `limit` were returned).',
  })
  next_cursor!: string | null;
}
