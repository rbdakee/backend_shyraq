import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateChildDto {
  @ApiPropertyOptional({ example: 'Айгерим Серикқызы', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  full_name?: string;

  @ApiPropertyOptional({
    example: '040315500123',
    nullable: true,
    description: 'Set to null to clear, otherwise 12-digit IIN.',
  })
  @ValidateIf((o: UpdateChildDto) => o.iin !== null && o.iin !== undefined)
  @IsString()
  @Matches(/^\d{12}$/)
  iin?: string | null;

  @ApiPropertyOptional({ example: '2021-09-15' })
  @IsOptional()
  @IsDateString()
  date_of_birth?: string;

  @ApiPropertyOptional({ enum: ['male', 'female'], nullable: true })
  @ValidateIf((o: UpdateChildDto) => o.gender !== null)
  @IsOptional()
  @IsIn(['male', 'female'])
  gender?: 'male' | 'female' | null;

  @ApiPropertyOptional({
    example: 'https://cdn.shyraq.kz/photos/aigerim.jpg',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  photo_url?: string | null;

  @ApiPropertyOptional({ example: 'No chronic conditions.', nullable: true })
  @IsOptional()
  @IsString()
  medical_notes?: string | null;

  @ApiPropertyOptional({ example: 'Peanut allergy.', nullable: true })
  @IsOptional()
  @IsString()
  allergy_notes?: string | null;
}
