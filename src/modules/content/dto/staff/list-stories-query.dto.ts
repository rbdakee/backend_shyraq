import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

export class ListStoriesQueryDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description:
      'Filter active stories by group. Mentor: defaults to their own groups if omitted. Admin: all groups in kg if omitted.',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  group_id?: string;
}
