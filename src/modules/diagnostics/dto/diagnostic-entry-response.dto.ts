import { ApiProperty } from '@nestjs/swagger';

export class DiagnosticEntryResponseDto {
  @ApiProperty({ example: 'eeeeeeee-5555-5555-5555-eeeeeeeeeeee' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({ example: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa' })
  template_id!: string;

  @ApiProperty({
    example: 'Речевое обследование 3–5 лет',
    description: 'Template name at time of entry (fetched from template row).',
  })
  template_name!: string;

  @ApiProperty({
    example: 1,
    description:
      'Template version at time of entry (fetched from template row).',
  })
  template_version!: number;

  @ApiProperty({ example: 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb' })
  specialist_id!: string;

  @ApiProperty({
    example: 'Айгерим Нурланкызы',
    nullable: true,
    description:
      'Specialist display name resolved from staff_members.id → staff identity ' +
      'fallback (staff_members.full_name ?? users.full_name). Null when the ' +
      'staff row is missing or the resolved name is empty/whitespace-only.',
  })
  specialist_full_name!: string | null;

  @ApiProperty({
    example: '2026-05-01',
    description: 'Assessment date (ISO date YYYY-MM-DD).',
  })
  assessment_date!: string;

  @ApiProperty({
    example: { articulation_score: 4, notes: 'Хорошая динамика' },
    description: 'Filled data payload conforming to template schema.',
  })
  data!: Record<string, unknown>;

  @ApiProperty({
    example: 'Ребёнок демонстрирует положительную динамику в произношении.',
    nullable: true,
  })
  summary!: string | null;

  @ApiProperty({
    example: 'Рекомендуется продолжить логопедические занятия 2 раза в неделю.',
    nullable: true,
  })
  recommendations!: string | null;

  @ApiProperty({
    example: ['https://storage.example.com/diagnostics/report-2026-05-01.pdf'],
    type: [String],
  })
  attachments!: string[];

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-02T11:00:00.000Z' })
  updated_at!: string;
}

export class DiagnosticEntryListResponseDto {
  @ApiProperty({ type: [DiagnosticEntryResponseDto] })
  items!: DiagnosticEntryResponseDto[];

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Cursor for next page. Null when no more pages.',
  })
  next_cursor!: string | null;
}
