import { ApiProperty } from '@nestjs/swagger';
import {
  PARENT_REQUEST_STATUS_VALUES,
  PARENT_REQUEST_TYPE_VALUES,
  type ParentRequestStatusValue,
  type ParentRequestTypeValue,
} from '../infrastructure/persistence/relational/entities/parent-request.typeorm.entity';

/**
 * Response shape for parent_requests endpoints. snake_case keys per the wire
 * contract; presenter does the conversion from camelCase domain state.
 *
 * `details` is a free-form jsonb blob whose shape varies per `request_type`:
 *   - trusted_person: { full_name, phone, iin?, relation, photo_url?,
 *                       is_one_time?, create_pickup_request?, comment? }
 *   - day_off:        { weekend_dates: ['YYYY-MM-DD', ...], comment? }
 *   - vacation:       { comment? }
 *   - late_pickup:    { expected_time: 'HH:MM', tariff_amount_kzt?, comment? }
 *   - open_request:   { subject, message, attachments? }
 *
 * Internal-only fields (otp_ref, etc.) are NEVER surfaced — every value here
 * is safe to expose to the caller.
 */
export class ParentRequestResponseDto {
  @ApiProperty({ example: '11111111-2222-3333-4444-555555555555' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({
    example: 'Аружан Серикова',
    nullable: true,
    description:
      'Child display name overlay (children.id → full_name within caller kg; ' +
      'includes archived). Null when missing/cross-tenant.',
  })
  child_name!: string | null;

  @ApiProperty({ example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  requester_user_id!: string;

  @ApiProperty({
    example: 'day_off',
    enum: PARENT_REQUEST_TYPE_VALUES,
  })
  request_type!: ParentRequestTypeValue;

  @ApiProperty({
    example: 'pending',
    enum: PARENT_REQUEST_STATUS_VALUES,
  })
  status!: ParentRequestStatusValue;

  @ApiProperty({
    example: '2026-05-04',
    nullable: true,
    description:
      'Inclusive start date (vacation: vacation start; late_pickup: the date of late pickup). Null when not applicable.',
  })
  date_from!: string | null;

  @ApiProperty({
    example: '2026-05-08',
    nullable: true,
    description:
      'Inclusive end date (vacation only). Null for everything else.',
  })
  date_to!: string | null;

  @ApiProperty({
    example: { comment: 'Бабушка прилетает в субботу' },
    description: 'Per-type payload — see `request_type`.',
  })
  details!: Record<string, unknown>;

  @ApiProperty({
    example: 'mentor',
    enum: ['admin', 'mentor', 'specialist'],
    nullable: true,
  })
  recipient_type!: 'admin' | 'mentor' | 'specialist' | null;

  @ApiProperty({
    example: 'bbbbbbbb-2222-3333-4444-bbbbbbbbbbbb',
    nullable: true,
  })
  recipient_staff_id!: string | null;

  @ApiProperty({
    example: 'Алия Серикова',
    nullable: true,
    description:
      'Display name of the recipient staff member — overlay resolved from `staff_members.id` → `users.full_name` (staff identity fallback). Null when `recipient_staff_id` is null, the staff row is missing, or the resolved name is blank.',
  })
  recipient_staff_full_name!: string | null;

  @ApiProperty({
    example: null,
    nullable: true,
    description:
      'staff_member id of the reviewer (set when status is accepted/rejected).',
  })
  reviewed_by!: string | null;

  @ApiProperty({
    example: 'Алия Серикова',
    nullable: true,
    description:
      'Display name of the reviewer staff member — overlay resolved from `reviewed_by` (`staff_members.id`) → `users.full_name` (staff identity fallback). Null when `reviewed_by` is null, the staff row is missing, or the resolved name is blank.',
  })
  reviewed_by_full_name!: string | null;

  @ApiProperty({ example: null, nullable: true })
  reviewed_at!: string | null;

  @ApiProperty({ example: null, nullable: true })
  review_note!: string | null;

  @ApiProperty({
    example: '99999999-aaaa-bbbb-cccc-999999999999',
    nullable: true,
    description:
      'Invoice id linked to this request. Populated for `late_pickup` after staff accepts (B13 hook auto-emits a `late_pickup_fee` invoice and links it). `null` for every other request_type and for `late_pickup` while still `pending`.',
  })
  invoice_id!: string | null;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  updated_at!: string;
}

export class ParentRequestListResponseDto {
  @ApiProperty({ type: [ParentRequestResponseDto] })
  items!: ParentRequestResponseDto[];

  @ApiProperty({
    example: null,
    nullable: true,
    description:
      'Cursor for the next page — pass back as `cursor` query. Null on last page.',
  })
  next_cursor!: string | null;
}
