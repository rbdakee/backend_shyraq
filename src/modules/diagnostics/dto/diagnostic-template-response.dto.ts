import { ApiProperty } from '@nestjs/swagger';

export class DiagnosticTemplateResponseDto {
  @ApiProperty({ example: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'speech_therapist' })
  specialist_type!: string;

  @ApiProperty({ example: 'Речевое обследование 3–5 лет' })
  name!: string;

  @ApiProperty({
    example: 'Стандартный протокол речевого обследования для детей 3–5 лет.',
    nullable: true,
  })
  description!: string | null;

  @ApiProperty({
    example: 1,
    description: 'Schema version. Incremented on structural schema changes.',
  })
  version!: number;

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({
    example: {
      fields: [
        { key: 'articulation_score', label: 'Артикуляция', type: 'number' },
        { key: 'notes', label: 'Примечания', type: 'text' },
      ],
    },
    description: 'Template schema defining the entry data structure.',
  })
  schema!: Record<string, unknown>;

  @ApiProperty({ example: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb' })
  created_by!: string;

  @ApiProperty({ example: '2026-01-15T08:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-03-20T10:30:00.000Z' })
  updated_at!: string;
}

export class DiagnosticTemplateListResponseDto {
  @ApiProperty({ type: [DiagnosticTemplateResponseDto] })
  items!: DiagnosticTemplateResponseDto[];

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Cursor for next page. Null when no more pages.',
  })
  next_cursor!: string | null;
}
