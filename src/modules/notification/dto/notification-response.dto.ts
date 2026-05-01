import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Single notification history item returned by `GET /notifications`.
 *
 * Localization note: `title_i18n` / `body_i18n` are returned as raw JSONB
 * objects (e.g. `{"ru": "Ребёнок пришёл", "kk": "Бала келді"}`).
 * Clients are responsible for picking the locale key. This avoids a
 * `UsersRepository` lookup on every list fetch while keeping the payload
 * fully locale-capable. See T7 deliverable notes.
 */
export class NotificationResponseDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID of the notification row.',
  })
  id!: string;

  @ApiProperty({
    example: 'attendance.checkin',
    description: 'Notification event key.',
  })
  event_key!: string;

  @ApiProperty({
    example: { ru: 'Ребёнок пришёл', kk: 'Бала келді' },
    description:
      'Title per locale (JSONB). Clients resolve their preferred locale key.',
  })
  title_i18n!: Record<string, string>;

  @ApiProperty({
    example: { ru: 'Айдар Сейткали зачекинен в 09:00', kk: '...' },
    description:
      'Body per locale (JSONB). Clients resolve their preferred locale key.',
  })
  body_i18n!: Record<string, string>;

  @ApiProperty({
    example: { child_id: 'uuid', event_id: 'uuid' },
    description: 'Arbitrary event payload for deep-linking.',
  })
  data!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: '2026-05-01T10:05:00.000Z',
    nullable: true,
    description: 'ISO timestamp when the notification was read. Null = unread.',
  })
  read_at!: string | null;

  @ApiProperty({
    example: '2026-05-01T09:00:00.000Z',
    description: 'ISO timestamp when the notification was created.',
  })
  created_at!: string;
}
