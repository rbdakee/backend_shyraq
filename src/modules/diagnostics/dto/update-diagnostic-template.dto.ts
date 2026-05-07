import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class UpdateDiagnosticTemplateDto {
  @ApiProperty({
    example: 'Речевое обследование 4–6 лет',
    description: 'New name for the template.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiProperty({
    example: 'Обновлённый протокол обследования.',
    description: 'New description.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiProperty({
    example: {
      sections: [
        {
          title: 'Речь',
          fields: [
            {
              key: 'articulation_score',
              label: 'Артикуляция',
              type: 'number',
              required: true,
            },
            {
              key: 'vocabulary_score',
              label: 'Словарный запас',
              type: 'number',
              required: false,
            },
            {
              key: 'notes',
              label: 'Примечания',
              type: 'text',
              required: false,
            },
          ],
        },
      ],
    },
    description:
      'Replacement schema. Must follow `{ sections: [{ title, fields: [{ key, label, type, required }] }] }`. Service bumps version if the schema deeply differs from the previous one.',
    required: false,
  })
  @IsOptional()
  @IsObject()
  schema?: Record<string, unknown>;
}
