import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  SLOT_CATEGORY_VALUES,
  SlotCategoryValue,
} from '../domain/value-objects/slot-category.vo';

export class UpdateActivityEventDto {
  @ApiPropertyOptional({ example: 'Прогулка (изменено)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  activityName?: string;

  @ApiPropertyOptional({ enum: SLOT_CATEGORY_VALUES, example: 'activity' })
  @IsOptional()
  @IsIn(SLOT_CATEGORY_VALUES)
  category?: SlotCategoryValue;

  @ApiPropertyOptional({ example: 'b2a1c0d9-0000-0000-0000-000000000001' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiPropertyOptional({
    example: '2026-05-04T10:00:00.000Z',
    description:
      'ISO timestamp. A zoneless value (e.g. 2026-05-04T09:00) is interpreted as kindergarten-local (Asia/Almaty); a value with Z or an offset is honoured as-is.',
  })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({
    example: '2026-05-04T11:00:00.000Z',
    description:
      'ISO timestamp. A zoneless value (e.g. 2026-05-04T09:00) is interpreted as kindergarten-local (Asia/Almaty); a value with Z or an offset is honoured as-is.',
  })
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional({ example: 'Заметка' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
