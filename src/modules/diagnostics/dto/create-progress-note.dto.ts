import { ApiProperty } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

export class CreateProgressNoteDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({
    example:
      'Ребёнок активно участвовал в занятиях, демонстрирует интерес к рисованию.',
    description: 'Note body text. Cannot be empty.',
  })
  @IsString()
  @IsNotEmpty()
  body!: string;

  @ApiProperty({
    example: ['https://storage.example.com/notes/drawing-2026-05-01.jpg'],
    description: 'Optional array of media attachment URLs.',
    required: false,
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  media_urls?: string[];

  @ApiProperty({
    example: '2026-05-01T09:30:00.000Z',
    description:
      'ISO timestamp of when the note was recorded. Defaults to server time when omitted. Cannot exceed now + 5 minutes.',
    required: false,
  })
  @IsOptional()
  @IsDateString()
  noted_at?: string;
}
