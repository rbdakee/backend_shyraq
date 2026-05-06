import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListMessagesQueryDto {
  @ApiProperty({ example: 50, required: false, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiProperty({
    example: null,
    required: false,
    nullable: true,
    description:
      'Cursor (ISO timestamp of the last message returned by the previous page).',
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
