import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

const PHONE_REGEX = /^\+[1-9]\d{10,14}$/;

/**
 * Body shape for `POST /parent/requests/otp-request`. Generates a 6-digit code,
 * stores it under `otp:request:trusted-person:{userId}` (TTL 300s), and SMSes
 * to `phone`. Per-phone rate-limit shared with auth's `rate:otp:{phone}` so
 * abusing this endpoint cannot earn extra login OTP budget.
 */
export class OtpRequestDto {
  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'UUID of the child the trusted person is being added for.',
  })
  @IsUUID()
  child_id!: string;

  @ApiProperty({
    example: '+77071234567',
    description:
      'E.164 phone number — receives the verification SMS. Must match the trusted-person phone the parent will submit to /trusted-person endpoint.',
  })
  @IsString()
  @Matches(PHONE_REGEX, {
    message:
      'phone must be in E.164 format (+ followed by 11–15 digits, no spaces)',
  })
  phone!: string;
}

export class OtpRequestResponseDto {
  @ApiProperty({
    example: 'otp:request:trusted-person:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    description: 'Opaque Redis key reference — pass back via /trusted-person.',
  })
  otp_ref!: string;

  @ApiProperty({ example: 300, description: 'TTL in seconds.' })
  expires_in!: number;
}
