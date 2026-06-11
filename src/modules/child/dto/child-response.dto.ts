import { ApiProperty } from '@nestjs/swagger';

export class ChildDto {
  @ApiProperty({ example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  id!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({ example: '040315500123', nullable: true })
  iin!: string | null;

  @ApiProperty({ example: 'Айгерим Нурсултанкызы' })
  full_name!: string;

  @ApiProperty({ example: '2021-09-15' })
  date_of_birth!: string;

  @ApiProperty({ example: 'female', enum: ['male', 'female'], nullable: true })
  gender!: 'male' | 'female' | null;

  @ApiProperty({
    example: 'https://cdn.shyraq.kz/photos/aigerim.jpg',
    nullable: true,
  })
  photo_url!: string | null;

  @ApiProperty({ enum: ['card_created', 'active', 'archived'] })
  status!: 'card_created' | 'active' | 'archived';

  @ApiProperty({
    example: 'b2c3d4e5-1234-5678-abcd-1234567890ab',
    nullable: true,
  })
  current_group_id!: string | null;

  @ApiProperty({
    example: 'Подготовительная «А»',
    nullable: true,
    description:
      'Display name of the current group, resolved from `groups` (identity ' +
      'overlay). Null when the child has no group, the group name is blank, ' +
      'or the overlay was not built for this response (e.g. cross-tenant ' +
      'parent listing).',
  })
  current_group_name!: string | null;

  @ApiProperty({ example: null, nullable: true })
  enrollment_date!: string | null;

  @ApiProperty({ example: null, nullable: true })
  archived_at!: string | null;

  @ApiProperty({ example: null, nullable: true })
  archive_reason!: string | null;

  @ApiProperty({ example: null, nullable: true })
  medical_notes!: string | null;

  @ApiProperty({ example: 'Peanut allergy.', nullable: true })
  allergy_notes!: string | null;

  @ApiProperty({ example: '2026-04-26T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-04-26T10:00:00.000Z' })
  updated_at!: string;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 42 })
  total!: number;
  @ApiProperty({ example: 20 })
  limit!: number;
  @ApiProperty({ example: 0 })
  offset!: number;
}

export class ChildListResponseDto {
  @ApiProperty({ type: [ChildDto] })
  data!: ChildDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}
