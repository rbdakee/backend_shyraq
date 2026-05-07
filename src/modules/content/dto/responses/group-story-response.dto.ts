import { ApiProperty } from '@nestjs/swagger';

export class GroupStoryResponseDto {
  @ApiProperty({ example: 'd1e2f3a4-0000-0000-0000-000000000011' })
  id!: string;

  @ApiProperty({ example: 'a0b1c2d3-0000-0000-0000-000000000099' })
  kindergarten_id!: string;

  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  group_id!: string;

  @ApiProperty({ example: 'b0c1d2e3-0000-0000-0000-000000000007' })
  created_by!: string;

  @ApiProperty({ example: '/static/kg-id/stories/2026-05/xyz.jpg' })
  media_url!: string;

  @ApiProperty({ example: 'image', enum: ['image', 'video'] })
  media_type!: string;

  @ApiProperty({
    example: 'Дети лепят снеговика на прогулке',
    nullable: true,
  })
  caption!: string | null;

  @ApiProperty({ example: 5, description: 'Number of unique views.' })
  views!: number;

  @ApiProperty({ example: '2026-05-08T09:00:00.000Z' })
  expires_at!: string;

  @ApiProperty({ example: '2026-05-07T09:00:00.000Z' })
  created_at!: string;
}
