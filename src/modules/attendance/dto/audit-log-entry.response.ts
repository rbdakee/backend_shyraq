import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AUDIT_ACTION_VALUES,
  AuditAction,
} from '@/modules/audit/domain/entities/audit-log-entry.entity';

/**
 * One entry of an attendance event's correction history
 * (`GET /admin/attendance-events/:eventId/history`).
 *
 * `before` / `after` are the raw row snapshots the mutation moved between, so
 * the admin UI can diff them field-by-field without the backend having to
 * guess which fields are interesting. They are stored as jsonb: timestamps
 * come back as ISO strings, not Date objects.
 */
export class AuditLogEntryResponseDto {
  @ApiProperty({ example: '11111111-2222-3333-4444-555555555555' })
  id!: string;

  @ApiProperty({
    enum: AUDIT_ACTION_VALUES,
    example: 'update',
    description:
      "'create' carries only `after`, 'delete' only `before`, 'update' both.",
  })
  action!: AuditAction;

  @ApiPropertyOptional({
    nullable: true,
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    description:
      'users.id of whoever performed the mutation. null for system/CLI paths.',
  })
  actorUserId!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Ирина Кайратовна',
    description:
      'Display name of the actor (identity overlay: staff_members.id → users.full_name). ' +
      'null when the actor is absent, no longer resolvable, or the name is empty/whitespace.',
  })
  actor_full_name!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    example: {
      childId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      eventType: 'check_in',
      recordedAt: '2026-05-01T09:00:00.000Z',
    },
    description: 'Row snapshot BEFORE the mutation. null on create.',
  })
  before!: Record<string, unknown> | null;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    example: {
      childId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      eventType: 'check_in',
      recordedAt: '2026-05-01T09:00:00.000Z',
    },
    description: 'Row snapshot AFTER the mutation. null on delete.',
  })
  after!: Record<string, unknown> | null;

  @ApiProperty({ example: '2026-05-01T10:15:00.000Z' })
  createdAt!: string;
}
