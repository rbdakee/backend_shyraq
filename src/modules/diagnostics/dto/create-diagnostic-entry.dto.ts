import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';

export class CreateDiagnosticEntryDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({ example: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa' })
  @IsUUID()
  template_id!: string;

  @ApiProperty({
    example: '2026-05-01',
    description: 'Assessment date in ISO format YYYY-MM-DD. Cannot be future.',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'assessment_date must be in YYYY-MM-DD format',
  })
  assessment_date!: string;

  @ApiProperty({
    example: { articulation_score: 4, notes: 'Хорошая динамика' },
    description:
      'Entry data payload. Must conform to the template schema fields.',
  })
  @IsObject()
  data!: Record<string, unknown>;

  @ApiProperty({
    example: 'Ребёнок демонстрирует положительную динамику в произношении.',
    description: 'Optional specialist summary.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  summary?: string | null;

  @ApiProperty({
    example: 'Рекомендуется продолжить логопедические занятия 2 раза в неделю.',
    description: 'Optional specialist recommendations.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  recommendations?: string | null;

  @ApiProperty({
    example: ['https://storage.example.com/diagnostics/report-2026-05-01.pdf'],
    description: 'Optional array of attachment URLs.',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}
