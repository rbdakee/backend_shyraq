import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { CANONICAL_EVENT_KEYS } from '../event-keys';

/** Single preference item returned in list responses. */
export class NotificationPreferenceItemDto {
  @ApiProperty({
    example: 'attendance.checkin',
    description: 'The notification event key.',
  })
  event_key!: string;

  @ApiProperty({
    example: true,
    description: 'Whether push notifications are enabled for this event key.',
  })
  push_enabled!: boolean;

  @ApiProperty({
    example: true,
    description: 'Whether in-app notifications are enabled for this event key.',
  })
  in_app_enabled!: boolean;
}

/** Single item in the PATCH body — partial update. */
export class UpdateNotificationPreferenceItemDto {
  @ApiProperty({
    example: 'attendance.checkin',
    enum: CANONICAL_EVENT_KEYS,
    description: 'Must be a canonical event key.',
  })
  @IsIn(CANONICAL_EVENT_KEYS)
  event_key!: string;

  @ApiPropertyOptional({
    example: false,
    description: 'Set to false to disable push for this event key.',
  })
  @IsOptional()
  @IsBoolean()
  push_enabled?: boolean;

  @ApiPropertyOptional({
    example: true,
    description:
      'Set to false to disable in-app notification for this event key.',
  })
  @IsOptional()
  @IsBoolean()
  in_app_enabled?: boolean;
}
