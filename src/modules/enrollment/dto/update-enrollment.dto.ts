import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * PATCH payload for an enrollment. All fields are optional.
 *
 * Null is intentionally NOT accepted for any field here (per plan §4.4):
 * `@IsString()` rejects null values while `@IsOptional()` allows the field
 * to be absent entirely (undefined). This ensures null never reaches the
 * domain `update()` method through the HTTP boundary.
 */
export class UpdateEnrollmentDto {
  @ApiPropertyOptional({ example: 'Айгуль Серикова' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  contactName?: string;

  @ApiPropertyOptional({ example: '+77011112233' })
  @IsOptional()
  @IsString()
  @Matches(/^\+7\d{10}$/)
  contactPhone?: string;

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
  @IsString()
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
