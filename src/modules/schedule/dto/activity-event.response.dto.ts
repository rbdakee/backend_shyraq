import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ACTIVITY_EVENT_STATUS_VALUES,
  ActivityEventStatusValue,
} from '../domain/value-objects/activity-event-status.vo';
import {
  SLOT_CATEGORY_VALUES,
  SlotCategoryValue,
} from '../domain/value-objects/slot-category.vo';

export class ActivityEventResponseDto {
  @ApiProperty({ example: 'e1a2b3c4-0000-0000-0000-000000000001' })
  id!: string;

  @ApiProperty({ example: 'f1a2b3c4-0000-0000-0000-000000000001' })
  kindergartenId!: string;

  @ApiProperty({ example: 'a1b2c3d4-0000-0000-0000-000000000010' })
  groupId!: string;

  @ApiPropertyOptional({
    example: 'b1a2c3d4-0000-0000-0000-000000000001',
    nullable: true,
    description: 'null = ad-hoc event',
  })
  templateSlotId!: string | null;

  @ApiProperty({ example: 'Утренний круг' })
  activityName!: string;

  @ApiProperty({ enum: SLOT_CATEGORY_VALUES, example: 'activity' })
  category!: SlotCategoryValue;

  @ApiPropertyOptional({
    example: 'b2a1c0d9-0000-0000-0000-000000000001',
    nullable: true,
  })
  locationId!: string | null;

  @ApiProperty({
    example: 'Музыкальный зал',
    nullable: true,
    description:
      'Display name resolved from locationId → locations.name. null when locationId is null, the location is not found, or its name is blank/whitespace.',
  })
  location_name!: string | null;

  @ApiProperty({ example: '2026-05-04T09:00:00.000Z' })
  startsAt!: string;

  @ApiPropertyOptional({ example: '2026-05-04T09:45:00.000Z', nullable: true })
  endsAt!: string | null;

  @ApiProperty({ enum: ACTIVITY_EVENT_STATUS_VALUES, example: 'scheduled' })
  status!: ActivityEventStatusValue;

  @ApiPropertyOptional({
    example: 'c1a2b3d4-0000-0000-0000-000000000001',
    nullable: true,
  })
  createdBy!: string | null;

  @ApiPropertyOptional({ example: 'Заметка', nullable: true })
  notes!: string | null;

  @ApiProperty({ example: '2026-04-30T10:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ example: '2026-04-30T10:00:00.000Z' })
  updatedAt!: string;
}
