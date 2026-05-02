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
 * Body shape for `POST /staff/pickup-requests` (staff-create).
 *
 * Two modes:
 *   - whitelist: pass `trusted_person_id` (UUID), snapshot fields are
 *     read from the row and ignored on the body.
 *   - ad-hoc: pass `trusted_person_name` + `trusted_person_phone` (and
 *     optional iin) without a `trusted_person_id`. The service snapshots
 *     these onto the row directly.
 *
 * `child_id` is required on the body (the staff endpoint has no
 * URL `:id` param). Wire keys are snake_case per the project endpoints.md
 * convention; the controller maps to camelCase service-layer types via
 * local destructuring.
 */
export class StaffCreatePickupRequestDto {
  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'UUID of the child being picked up',
  })
  @IsUUID()
  child_id!: string;

  @ApiProperty({
    example: '11111111-2222-3333-4444-555555555555',
    description:
      'UUID of an existing trusted_people row. Mutually exclusive with the ad-hoc fields below.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  trusted_person_id?: string | null;

  @ApiProperty({
    example: 'Айгуль Бекмаганбетова',
    description:
      'Required when trusted_person_id is null/absent (ad-hoc trusted person).',
    required: false,
    minLength: 2,
    maxLength: 200,
  })
  @ValidateIf(
    (o: StaffCreatePickupRequestDto) =>
      o.trusted_person_id === undefined || o.trusted_person_id === null,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  trusted_person_name?: string;

  @ApiProperty({
    example: '+77071234567',
    description:
      'Required when trusted_person_id is null/absent (ad-hoc trusted person).',
    required: false,
  })
  @ValidateIf(
    (o: StaffCreatePickupRequestDto) =>
      o.trusted_person_id === undefined || o.trusted_person_id === null,
  )
  @IsString()
  @Matches(PHONE_REGEX, {
    message:
      'phone must be in E.164 format (+ followed by 11–15 digits, no spaces)',
  })
  trusted_person_phone?: string;

  @ApiProperty({
    example: '880101400123',
    description: 'Optional 12-digit Kazakh IIN (ad-hoc only).',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(IIN_REGEX, { message: 'iin must be exactly 12 digits' })
  trusted_person_iin?: string | null;
}

/**
 * Body shape for `POST /parent/children/:id/pickup-requests` (parent-create).
 *
 * `child_id` is NOT on the body — it is derived from the URL `:id` path
 * param. The two trusted-person modes (whitelist vs ad-hoc) match the
 * staff DTO above. Wire keys snake_case.
 */
export class ParentCreatePickupRequestDto {
  @ApiProperty({
    example: '11111111-2222-3333-4444-555555555555',
    description:
      'UUID of an existing trusted_people row. Mutually exclusive with the ad-hoc fields below.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  trusted_person_id?: string | null;

  @ApiProperty({
    example: 'Айгуль Бекмаганбетова',
    description:
      'Required when trusted_person_id is null/absent (ad-hoc trusted person).',
    required: false,
    minLength: 2,
    maxLength: 200,
  })
  @ValidateIf(
    (o: ParentCreatePickupRequestDto) =>
      o.trusted_person_id === undefined || o.trusted_person_id === null,
  )
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  trusted_person_name?: string;

  @ApiProperty({
    example: '+77071234567',
    description:
      'Required when trusted_person_id is null/absent (ad-hoc trusted person).',
    required: false,
  })
  @ValidateIf(
    (o: ParentCreatePickupRequestDto) =>
      o.trusted_person_id === undefined || o.trusted_person_id === null,
  )
  @IsString()
  @Matches(PHONE_REGEX, {
    message:
      'phone must be in E.164 format (+ followed by 11–15 digits, no spaces)',
  })
  trusted_person_phone?: string;

  @ApiProperty({
    example: '880101400123',
    description: 'Optional 12-digit Kazakh IIN (ad-hoc only).',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(IIN_REGEX, { message: 'iin must be exactly 12 digits' })
  trusted_person_iin?: string | null;
}
