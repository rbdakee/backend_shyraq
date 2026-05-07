import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class UpdateProgressNoteDto {
  @ApiProperty({
    example: 'Обновлённый текст заметки о прогрессе ребёнка.',
    description: 'Replacement body text. Cannot be empty.',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  body?: string;

  @ApiProperty({
    example: ['https://storage.example.com/notes/updated-drawing.jpg'],
    description: 'Replacement media URL array (replaces existing array).',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_urls?: string[];
}
