import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CheckInDto {
  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'Child to check in.',
  })
  @IsUUID()
  childId!: string;

  @ApiPropertyOptional({
    example: '2026-05-01T09:00:00.000Z',
    description:
      'ISO timestamp (UTC). Defaults to server clock. Mainly used by tests + admin late-recording.',
  })
  @IsOptional()
  @IsDateString()
  recordedAt?: string;

  @ApiPropertyOptional({
    example: 'Прибыл с папой',
    description: 'Free-form note (≤2000 chars).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
