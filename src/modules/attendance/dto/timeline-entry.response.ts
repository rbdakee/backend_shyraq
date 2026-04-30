import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  TIMELINE_ENTRY_TYPE_VALUES,
  TimelineEntryTypeValue,
} from '../domain/value-objects/timeline-entry-type.vo';

export class TimelineEntryResponseDto {
  @ApiProperty({ example: 't1111111-1111-1111-1111-111111111111' })
  id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  childId!: string;

  @ApiProperty({ enum: TIMELINE_ENTRY_TYPE_VALUES, example: 'activity' })
  entryType!: TimelineEntryTypeValue;

  @ApiPropertyOptional({ example: 'Утренняя зарядка', nullable: true })
  title!: string | null;

  @ApiPropertyOptional({
    example: 'Дети сделали разминку в спортивном зале.',
    nullable: true,
  })
  body!: string | null;

  @ApiPropertyOptional({
    type: [String],
    example: ['https://cdn.shyraq.kz/photos/abc123.jpg'],
    nullable: true,
  })
  mediaUrls!: string[] | null;

  @ApiPropertyOptional({ example: { mood: 'happy' }, nullable: true })
  metadata!: Record<string, unknown> | null;

  @ApiPropertyOptional({
    example: 'sssssssss-ssss-ssss-ssss-ssssssssssss',
    nullable: true,
    description: 'staff_members.id of the author.',
  })
  recordedBy!: string | null;

  @ApiProperty({ example: '2026-05-01T09:30:00.000Z' })
  entryTime!: string;

  @ApiProperty({ example: '2026-05-01T09:30:01.234Z' })
  createdAt!: string;
}

export class PagedTimelineResponseDto {
  @ApiProperty({ type: [TimelineEntryResponseDto] })
  items!: TimelineEntryResponseDto[];

  @ApiPropertyOptional({
    nullable: true,
    example:
      'MjAyNi0wNS0wMVQwOTozMDowMC4wMDBafHQxMTExMTExMS0xMTExLTExMTEtMTExMS0xMTExMTExMTExMTE',
    description: 'Cursor for the next page. null when there are no more pages.',
  })
  nextCursor!: string | null;
}
