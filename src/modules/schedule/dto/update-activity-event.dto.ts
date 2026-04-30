import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class UpdateActivityEventDto {
  @ApiPropertyOptional({ example: 'Прогулка (изменено)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  activityName?: string;

  @ApiPropertyOptional({ example: 'b2a1c0d9-0000-0000-0000-000000000001' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({ example: '2026-05-04T10:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({ example: '2026-05-04T11:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional({ example: 'Заметка' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
