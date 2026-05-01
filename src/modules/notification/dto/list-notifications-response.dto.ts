import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationResponseDto } from './notification-response.dto';

export class ListNotificationsResponseDto {
  @ApiProperty({
    type: [NotificationResponseDto],
    description: 'Notification history items, newest first.',
  })
  items!: NotificationResponseDto[];

  @ApiPropertyOptional({
    example:
      'eyJjcmVhdGVkQXQiOiIyMDI2LTA1LTAxVDEwOjAwOjAwLjAwMFoiLCJpZCI6InV1aWQifQ==',
    nullable: true,
    description:
      'Opaque base64 cursor for the next page. Null when there are no more results.',
  })
  next_cursor!: string | null;
}
