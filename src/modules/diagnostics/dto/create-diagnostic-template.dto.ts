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
      fields: [
        { key: 'articulation_score', label: 'Артикуляция', type: 'number' },
        { key: 'notes', label: 'Примечания', type: 'text' },
      ],
    },
    description:
      'JSON schema for entry data. The service validates the shape (must have `fields` array with `key`+`label`+`type`).',
  })
  @IsObject()
  schema!: Record<string, unknown>;
}
