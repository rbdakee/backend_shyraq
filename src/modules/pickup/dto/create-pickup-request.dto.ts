import { ApiProperty } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const PHONE_REGEX = /^\+[1-9]\d{10,14}$/;
const IIN_REGEX = /^\d{12}$/;

/**
 * Body shape for `POST /staff/pickup-requests` (staff-create) AND
 * `POST /parent/children/:id/pickup-requests` (parent-create).
 *
 * Two modes:
 *   - whitelist: pass `trusted_person_id` (UUID), snapshot fields are
 *     read from the row and ignored on the body.
 *   - ad-hoc: pass `trusted_person_name` + `trusted_person_phone` (and
 *     optional iin) without a `trusted_person_id`. The service snapshots
 *     these onto the row directly.
 *
 * `child_id` is on the body for the staff endpoint; the parent endpoint
 * derives it from the URL path and validates that the body's `child_id`,
 * if present, matches.
 */
export class CreatePickupRequestDto {
  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'UUID of the child being picked up',
  })
  @IsUUID()
  childId!: string;

  @ApiProperty({
    example: '11111111-2222-3333-4444-555555555555',
    description:
      'UUID of an existing trusted_people row. Mutually exclusive with the ad-hoc fields below.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  trustedPersonId?: string | null;

  @ApiProperty({
    example: 'Айгуль Бекмаганбетова',
    description:
      'Required when trustedPersonId is null/absent (ad-hoc trusted person).',
    required: false,
    minLength: 2,
    maxLength: 200,
  })
  @ValidateIf(
    (o: CreatePickupRequestDto) =>
      o.trustedPersonId === undefined || o.trustedPersonId === null,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  trustedPersonName?: string;

  @ApiProperty({
    example: '+77071234567',
    description:
      'Required when trustedPersonId is null/absent (ad-hoc trusted person).',
    required: false,
  })
  @ValidateIf(
    (o: CreatePickupRequestDto) =>
      o.trustedPersonId === undefined || o.trustedPersonId === null,
  )
  @IsString()
  @Matches(PHONE_REGEX, {
    message:
      'phone must be in E.164 format (+ followed by 11–15 digits, no spaces)',
  })
  trustedPersonPhone?: string;

  @ApiProperty({
    example: '880101400123',
    description: 'Optional 12-digit Kazakh IIN (ad-hoc only).',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(IIN_REGEX, { message: 'iin must be exactly 12 digits' })
  trustedPersonIin?: string | null;
}
