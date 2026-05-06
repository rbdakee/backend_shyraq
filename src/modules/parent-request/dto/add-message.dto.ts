import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AddMessageDto {
  @ApiProperty({
    example: 'Спасибо! Жду ответа.',
    minLength: 1,
    maxLength: 4000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;

  @ApiProperty({
    example: ['https://cdn.example.com/files/photo.jpg'],
    isArray: true,
    type: 'string',
    nullable: true,
    required: false,
    maxItems: 10,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  attachments?: string[] | null;
}
