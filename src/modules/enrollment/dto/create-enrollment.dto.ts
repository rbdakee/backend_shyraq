import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateEnrollmentDto {
  @ApiProperty({ example: 'Айгуль Серикова' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  contactName!: string;

  @ApiProperty({ example: '+77011112233' })
  @IsString()
  @Matches(/^\+7\d{10}$/)
  contactPhone!: string;

  @ApiPropertyOptional({ example: 'Алия Серикова' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  childName?: string;

  @ApiPropertyOptional({
    example: '2021-08-15',
    description: 'ISO date YYYY-MM-DD',
  })
  @IsOptional()
  @IsDateString()
  childDob?: string;

  @ApiPropertyOptional({ example: '210815500123' })
  @IsOptional()
  @Matches(/^\d{12}$/)
  childIin?: string;

  @ApiPropertyOptional({ example: 'instagram_ad' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  source?: string;

  @ApiPropertyOptional({ example: 'Хочет с октября 2026' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ example: 'b2a1c0d9-0000-0000-0000-000000000001' })
  @IsOptional()
  @IsUUID()
  assignedTo?: string;
}
