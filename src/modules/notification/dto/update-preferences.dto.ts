import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayNotEmpty, IsArray, ValidateNested } from 'class-validator';
import { UpdateNotificationPreferenceItemDto } from './notification-preference.dto';

export class UpdatePreferencesDto {
  @ApiProperty({
    type: [UpdateNotificationPreferenceItemDto],
    description:
      'List of preference updates. Each entry identifies an event_key and ' +
      'the flags to change. Omitted flags keep their current value.',
    example: [
      { event_key: 'attendance.checkin', push_enabled: false },
      { event_key: 'progress_note.new', in_app_enabled: false },
    ],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => UpdateNotificationPreferenceItemDto)
  preferences!: UpdateNotificationPreferenceItemDto[];
}
