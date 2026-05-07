import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateDiagnosticEntryDto {
  @ApiProperty({
    example: { articulation_score: 5, notes: 'Отличная динамика' },
    description:
      'Replacement data payload. Must still conform to the template schema.',
    required: false,
  })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  @ApiProperty({
    example: 'Ребёнок показал значительный прогресс.',
    description: 'Updated summary.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  summary?: string | null;

  @ApiProperty({
    example: 'Продолжить занятия, добавить домашние задания.',
    description: 'Updated recommendations.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  recommendations?: string | null;

  @ApiProperty({
    example: ['https://storage.example.com/diagnostics/updated-report.pdf'],
    description: 'Replacement attachment URLs (replaces existing array).',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  attachments?: string[];
}
