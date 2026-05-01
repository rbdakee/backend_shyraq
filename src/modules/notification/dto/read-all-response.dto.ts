import { ApiProperty } from '@nestjs/swagger';

export class ReadAllResponseDto {
  @ApiProperty({
    example: 5,
    description: 'Number of notifications that were marked as read.',
  })
  updated_count!: number;
}
