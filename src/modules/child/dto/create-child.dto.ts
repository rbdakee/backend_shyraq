import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateChildDto {
  @ApiProperty({ example: 'Айгерим Нурсултанкызы', maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  full_name!: string;

  @ApiPropertyOptional({
    example: '040315500123',
    description: 'Kazakhstani 12-digit IIN. Optional for card_created cards.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{12}$/)
  iin?: string;

  @ApiProperty({
    example: '2021-09-15',
    description: 'ISO date (YYYY-MM-DD). Cannot be in the future.',
  })
  @IsDateString()
  date_of_birth!: string;

  @ApiPropertyOptional({ enum: ['male', 'female'], example: 'female' })
  @IsOptional()
  @IsIn(['male', 'female'])
  gender?: 'male' | 'female';

  @ApiPropertyOptional({
    example: 'https://cdn.shyraq.kz/photos/aigerim.jpg',
  })
  @IsOptional()
  @IsString()
  photo_url?: string;

  @ApiPropertyOptional({
    example: 'b2c3d4e5-1234-5678-abcd-1234567890ab',
    description: 'UUID of an existing group within this kindergarten.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  current_group_id?: string;

  @ApiPropertyOptional({ example: 'No chronic conditions.' })
  @IsOptional()
  @IsString()
  medical_notes?: string;

  @ApiPropertyOptional({ example: 'Peanut allergy.' })
  @IsOptional()
  @IsString()
  allergy_notes?: string;
}
