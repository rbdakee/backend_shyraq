import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  SLOT_CATEGORY_VALUES,
  SlotCategoryValue,
} from '../domain/value-objects/slot-category.vo';

export class CreateActivityEventDto {
  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000001' })
  @IsUUID()
  groupId!: string;

  @ApiProperty({ example: 'Прогулка' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  activityName!: string;

  @ApiPropertyOptional({
    enum: SLOT_CATEGORY_VALUES,
    example: 'activity',
    default: 'activity',
    description:
      'Day-view colour bucket. Server default "activity" if omitted.',
  })
  @IsOptional()
  @IsIn(SLOT_CATEGORY_VALUES)
  category?: SlotCategoryValue;

  @ApiPropertyOptional({ example: 'b2a1c0d9-0000-0000-0000-000000000001' })
  @IsOptional()
  @IsUUID()
  locationId?: string;

  @ApiProperty({
    example: '2026-05-04T09:00:00.000Z',
    description: 'ISO timestamp (UTC).',
  })
  @IsDateString()
  startsAt!: string;

  @ApiPropertyOptional({ example: '2026-05-04T09:45:00.000Z' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional({ example: 'Доп. событие — выход в парк' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
