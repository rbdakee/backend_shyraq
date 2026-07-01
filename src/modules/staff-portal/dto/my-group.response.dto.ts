import { ApiProperty } from '@nestjs/swagger';

/**
 * One active mentor-group assignment of the calling staff member, with the
 * display metadata the Staff-App home screen renders
 * (`GET /staff/my-groups`).
 */
export class MyGroupResponseDto {
  @ApiProperty({
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
    description: 'Group id.',
  })
  id!: string;

  @ApiProperty({ example: 'Күншуақ', description: 'Group display name.' })
  name!: string;

  @ApiProperty({
    example: '4–5 лет',
    nullable: true,
    description:
      'Human-readable age range. Both bounds present → "4–5 лет" (en-dash); ' +
      'only the lower bound → "4+ лет"; neither set → null.',
  })
  age_range!: string | null;

  @ApiProperty({
    example: 'Каб. 204',
    nullable: true,
    description:
      "Display name of the group's current location (room), or null when no " +
      'location is assigned.',
  })
  room!: string | null;

  @ApiProperty({
    example: true,
    description:
      "Whether this is the caller's primary assignment for the group (from the " +
      'group_mentors row).',
  })
  is_primary!: boolean;

  @ApiProperty({
    example: 22,
    description: 'Count of active children currently assigned to the group.',
  })
  children_count!: number;
}
