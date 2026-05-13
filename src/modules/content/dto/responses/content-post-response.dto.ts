import { ApiProperty } from '@nestjs/swagger';

export class ContentPostResponseDto {
  @ApiProperty({ example: 'c1d2e3f4-0000-0000-0000-000000000001' })
  id!: string;

  @ApiProperty({ example: 'a0b1c2d3-0000-0000-0000-000000000099' })
  kindergarten_id!: string;

  @ApiProperty({
    example: 'news',
    enum: ['news', 'menu', 'schedule_pub', 'qundylyq', 'birthday'],
  })
  content_type!: string;

  @ApiProperty({
    example: 'all',
    enum: ['all', 'group', 'child'],
  })
  target_type!: string;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    nullable: true,
  })
  target_group_id!: string | null;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    nullable: true,
  })
  target_child_id!: string | null;

  @ApiProperty({ example: 'Важное объявление', nullable: true })
  title!: string | null;

  @ApiProperty({
    example: 'Просим всех родителей ознакомиться с новыми правилами.',
    nullable: true,
  })
  body!: string | null;

  @ApiProperty({
    example: { ru: 'Важное объявление', kk: 'Маңызды хабарландыру' },
    nullable: true,
  })
  title_i18n!: Record<string, string> | null;

  @ApiProperty({
    example: {
      ru: 'Просим всех родителей ознакомиться с новыми правилами.',
      kk: 'Барлық ата-аналарды жаңа ережелермен таныса беруін сұраймыз.',
    },
    nullable: true,
  })
  body_i18n!: Record<string, string> | null;

  @ApiProperty({
    example: ['/api/v1/media/kg-id/2026-05/abc.jpg'],
    nullable: true,
  })
  media_urls!: string[] | null;

  @ApiProperty({
    example: { month: '2026-05', theme: 'Kindness' },
    nullable: true,
  })
  metadata!: Record<string, unknown> | null;

  @ApiProperty({ example: '2026-05-10T07:00:00.000Z', nullable: true })
  scheduled_for!: string | null;

  @ApiProperty({ example: '2026-05-07T09:00:00.000Z', nullable: true })
  published_at!: string | null;

  @ApiProperty({ example: '2026-05-17T23:59:59.000Z', nullable: true })
  expires_at!: string | null;

  @ApiProperty({ example: 'draft', enum: ['draft', 'scheduled', 'published'] })
  status!: string;

  @ApiProperty({
    example: 'b0c1d2e3-0000-0000-0000-000000000007',
    nullable: true,
    description: 'users.id of the author; null for system-generated posts.',
  })
  created_by!: string | null;

  @ApiProperty({ example: '2026-05-07T08:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-07T08:00:00.000Z' })
  updated_at!: string;
}
