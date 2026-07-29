import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Body shape for `POST /parent/requests/otp-request`. Generates a 6-digit code,
 * stores it under `otp:request:trusted-person:{userId}` (TTL 1800s), and sends
 * it to the REQUESTING PARENT's own registered phone (re-auth — confirms the
 * parent themselves is creating the trusted-person request). Per-phone
 * rate-limit shared with auth login (`rate:otp:{phone}`).
 */
export class OtpRequestDto {
  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'UUID of the child the trusted person is being added for.',
  })
  @IsUUID()
  child_id!: string;
}

/**
 * Prefixed `TrustedPerson…` because `auth/dto/auth-response.dto.ts` already
 * exports an `OtpRequestResponseDto` (`{sent, registered, resend_after_sec}`).
 * Nest-Swagger keys `components.schemas` by class name, so the two collapsed
 * into a single schema and — since `ParentRequestModule` is registered after
 * `AuthModule` — this shape overwrote the auth one in `/docs-json`.
 */
export class TrustedPersonOtpRequestResponseDto {
  @ApiProperty({
    example: 'otp:request:trusted-person:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    description: 'Opaque Redis key reference — pass back via /trusted-person.',
  })
  otp_ref!: string;

  @ApiProperty({ example: 1800, description: 'TTL in seconds.' })
  expires_in!: number;
}
