import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';

/**
 * Partial update for a timeline_entry. entry_type and childId cannot be
 * changed after creation. An empty body is a no-op (all fields are optional).
 */
export class PatchTimelineEntryDto {
  @ApiPropertyOptional({ example: 'Утренняя зарядка (исправлено)' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string | null;

  @ApiPropertyOptional({ example: 'Дети сделали полную разминку.' })
  @IsOptional()
  @IsString()
  body?: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['https://cdn.shyraq.kz/photos/abc123.jpg'],
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @IsUrl({}, { each: true })
  mediaUrls?: string[] | null;

  @ApiPropertyOptional({ example: { mood: 'happy' }, nullable: true })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @ApiPropertyOptional({ example: '2026-05-01T09:30:00Z' })
  @IsOptional()
  @IsISO8601()
  entryTime?: string;
}
