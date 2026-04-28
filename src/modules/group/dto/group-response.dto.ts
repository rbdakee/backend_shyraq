import { ApiProperty } from '@nestjs/swagger';

export class GroupDto {
  @ApiProperty({ example: 'b2c3d4e5-1234-5678-abcd-1234567890ab' })
  id!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'Sunshine' })
  name!: string;

  @ApiProperty({ example: 20 })
  capacity!: number;

  @ApiProperty({ example: 12, nullable: true })
  age_range_min!: number | null;

  @ApiProperty({ example: 36, nullable: true })
  age_range_max!: number | null;

  @ApiProperty({
    example: 'a1b2c3d4-1234-5678-abcd-1234567890ab',
    nullable: true,
  })
  current_location_id!: string | null;

  @ApiProperty({ example: null, nullable: true })
  archived_at!: string | null;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  updated_at!: string;
}

export class GroupMentorDto {
  @ApiProperty({ example: 'gm-1234-5678-abcd-1234567890ab' })
  id!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'b2c3d4e5-1234-5678-abcd-1234567890ab' })
  group_id!: string;

  @ApiProperty({ example: 'stf-1234-5678-abcd-1234567890ab' })
  staff_member_id!: string;

  @ApiProperty({ example: true })
  is_primary!: boolean;

  @ApiProperty({ example: '2026-01-15T10:00:00.000Z' })
  assigned_at!: string;

  @ApiProperty({ example: null, nullable: true })
  unassigned_at!: string | null;

  @ApiProperty({ example: '2026-01-15T10:00:00.000Z' })
  created_at!: string;
}
