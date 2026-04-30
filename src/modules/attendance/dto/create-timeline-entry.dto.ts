import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
} from 'class-validator';

/**
 * Manual entry types that staff may create via the standalone timeline
 * endpoints. check_in / check_out are excluded — those are emitted
 * automatically by AttendanceService.checkIn / checkOut.
 */
const MANUAL_ENTRY_TYPES = [
  'activity',
  'meal',
  'nap',
  'note',
  'photo',
  'mood',
  'medication',
] as const;

export type ManualTimelineEntryType = (typeof MANUAL_ENTRY_TYPES)[number];

export class CreateTimelineEntryDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  childId!: string;

  @ApiProperty({
    enum: MANUAL_ENTRY_TYPES,
    example: 'activity',
    description:
      'Manual entry type. check_in / check_out are reserved for the attendance flow.',
  })
  @IsEnum(MANUAL_ENTRY_TYPES)
  entryType!: ManualTimelineEntryType;

  @ApiPropertyOptional({ example: 'Утренняя зарядка' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @ApiPropertyOptional({ example: 'Дети сделали разминку в спортивном зале.' })
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['https://cdn.shyraq.kz/photos/abc123.jpg'],
  })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  mediaUrls?: string[];

  @ApiPropertyOptional({ example: { mood: 'happy', energyLevel: 'high' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: '2026-05-01T09:30:00Z',
    description: 'When the event occurred. Defaults to server time if omitted.',
  })
  @IsOptional()
  @IsISO8601()
  entryTime?: string;
}
