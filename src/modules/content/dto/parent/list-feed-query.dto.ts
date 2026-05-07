import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListFeedQueryDto {
  @ApiProperty({
    example: 'eyJpZCI6IjEyMyJ9',
    description: 'Opaque cursor for pagination (from previous response).',
    required: false,
  })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiProperty({
    example: 20,
    description: 'Maximum items per section. Min 1, max 100. Default 20.',
    required: false,
    default: 20,
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
