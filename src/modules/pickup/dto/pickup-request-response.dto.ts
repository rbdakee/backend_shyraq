import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shape for staff + parent pickup_request endpoints. snake_case
 * keys per the wire contract; presenter does the conversion.
 */
export class PickupRequestResponseDto {
  @ApiProperty({ example: '11111111-2222-3333-4444-555555555555' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({ example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  requested_by_user_id!: string;

  @ApiProperty({
    example: '22222222-3333-4444-5555-666666666666',
    nullable: true,
    description:
      'UUID of the trusted_people row this request is bound to, or null for ad-hoc',
  })
  trusted_person_id!: string | null;

  @ApiProperty({ example: 'Айгуль Бекмаганбетова' })
  trusted_person_name!: string;

  @ApiProperty({
    example: '+77071234567',
    description:
      'Full E.164 KZ phone on single-get / create / validate / cancel endpoints. List endpoints (e.g. `GET /staff/pickup-requests`) return the masked form `+7***LAST4` for privacy (FINDINGS B11 H4); staff who need the full number must open the single-get endpoint.',
  })
  trusted_person_phone!: string;

  @ApiProperty({
    example: '880101400123',
    nullable: true,
  })
  trusted_person_iin!: string | null;

  @ApiProperty({
    example: 'otp_sent',
    enum: ['otp_sent', 'validated', 'expired', 'cancelled'],
  })
  status!: 'otp_sent' | 'validated' | 'expired' | 'cancelled';

  @ApiProperty({ example: null, nullable: true })
  validated_by!: string | null;

  @ApiProperty({ example: null, nullable: true })
  validated_at!: string | null;

  @ApiProperty({ example: null, nullable: true })
  attendance_event_id!: string | null;

  @ApiProperty({ example: null, nullable: true })
  parent_request_id!: string | null;

  @ApiProperty({ example: '2026-05-01T09:30:00.000Z' })
  expires_at!: string;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;
}

export class SendPickupOtpResponseDto {
  @ApiProperty({
    example: 'otp:pickup:11111111-2222-3333-4444-555555555555',
  })
  otp_ref!: string;

  @ApiProperty({ example: 1800, description: 'TTL in seconds' })
  expires_in!: number;
}

export class ValidatePickupOtpResponseDto {
  @ApiProperty({ type: PickupRequestResponseDto })
  pickup_request!: PickupRequestResponseDto;

  @ApiProperty({ example: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' })
  attendance_event_id!: string;
}
