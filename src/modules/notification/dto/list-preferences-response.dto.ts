import { ApiProperty } from '@nestjs/swagger';
import { NotificationPreferenceItemDto } from './notification-preference.dto';

export class ListPreferencesResponseDto {
  @ApiProperty({
    type: [NotificationPreferenceItemDto],
    description:
      'One entry per canonical event key. Rows without an explicit DB record ' +
      'use defaults: push_enabled=true, in_app_enabled=true.',
  })
  preferences!: NotificationPreferenceItemDto[];
}
