import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';

export class CreateDiagnosticTemplateDto {
  @ApiProperty({
    example: 'speech_therapist',
    description:
      'Specialist type this template belongs to. Must match a staff_member.specialist_type value.',
  })
  @IsString()
  @IsNotEmpty()
  specialist_type!: string;

  @ApiProperty({
    example: 'Речевое обследование 3–5 лет',
    description: 'Human-readable template name.',
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    example: 'Стандартный протокол речевого обследования для детей 3–5 лет.',
    description: 'Optional description for this template.',
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
      'JSON schema for entry data. Must be `{ sections: [{ title: string, fields: [{ key, label, type, required }] }] }` (validator: `validateTemplateSchemaShape`).',
  })
  @IsObject()
  schema!: Record<string, unknown>;
}
