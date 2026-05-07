import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CreateStoryDto {
  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'ID of the group this story belongs to.',
  })
  @IsNotEmpty()
  @IsUUID()
  group_id!: string;

  @ApiProperty({
    example: 'Дети лепят снеговика на прогулке ☃',
    description: 'Optional text caption (max 500 characters).',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string | null;
}
