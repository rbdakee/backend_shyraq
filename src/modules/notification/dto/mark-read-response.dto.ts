import { ApiProperty } from '@nestjs/swagger';

export class MarkReadResponseDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID of the notification that was marked read.',
  })
  id!: string;

  @ApiProperty({
    example: '2026-05-01T10:05:00.000Z',
    description: 'ISO timestamp when `read_at` was set.',
  })
  read_at!: string;
}
