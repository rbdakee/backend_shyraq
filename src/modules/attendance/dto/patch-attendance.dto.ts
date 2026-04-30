import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class PatchAttendanceDto {
  @ApiPropertyOptional({
    example: '2026-05-01T08:55:00.000Z',
    description: 'New recorded_at (ISO UTC).',
  })
  @IsOptional()
  @IsDateString()
  recordedAt?: string;

  @ApiPropertyOptional({
    example: 'Корректировка времени',
    description: 'New notes (overwrites previous).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string | null;

  @ApiPropertyOptional({
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    description:
      'New pickup_user_id (only valid on check_out events). Re-validated against guardian table when changed.',
  })
  @IsOptional()
  @IsUUID()
  pickupUserId?: string;
}
