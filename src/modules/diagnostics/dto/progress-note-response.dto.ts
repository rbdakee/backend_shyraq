import { ApiProperty } from '@nestjs/swagger';

export class ProgressNoteResponseDto {
  @ApiProperty({ example: 'fffffff-6666-6666-6666-ffffffffffff' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({ example: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb' })
  mentor_id!: string;

  @ApiProperty({
    example: 'Айгерим Нурланкызы',
    nullable: true,
    description:
      "Display name of the note's mentor, resolved from staff_members → " +
      'users (identity overlay). Null when the mentor has no resolvable ' +
      'profile name, or when the overlay was not built for this response.',
  })
  mentor_full_name!: string | null;

  @ApiProperty({
    example:
      'Ребёнок активно участвовал в занятиях, демонстрирует интерес к рисованию.',
  })
  body!: string;

  @ApiProperty({
    example: ['https://storage.example.com/notes/drawing-2026-05-01.jpg'],
    type: [String],
  })
  media_urls!: string[];

  @ApiProperty({ example: '2026-05-01T09:30:00.000Z' })
  noted_at!: string;

  @ApiProperty({ example: '2026-05-01T09:31:00.000Z' })
  created_at!: string;
}

export class ProgressNoteListResponseDto {
  @ApiProperty({ type: [ProgressNoteResponseDto] })
  items!: ProgressNoteResponseDto[];

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Cursor for next page. Null when no more pages.',
  })
  next_cursor!: string | null;
}
