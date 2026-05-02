import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

/**
 * Request body for `POST /staff/qr/scan`. The `token` is the plaintext value
 * the user app rendered as QR — staff app sends the decoded string.
 *
 * `device_id` is intentionally taken from the `X-Device-Id` request header
 * (not from the body) so the device-binding pattern matches the OTP-verify
 * flow that originally registered the refresh-token row. Service-side rate
 * limiting is keyed on that header value.
 */
export class ScanQrRequestDto {
  @ApiProperty({
    example: '2f1d4a9b6c7e8f0123456789abcdef01',
    description:
      'Plaintext QR token. 32 lowercase hex chars (16 random bytes hex-encoded).',
  })
  @IsString()
  @Length(32, 32)
  @Matches(/^[0-9a-f]{32}$/, {
    message: 'token must be 32 lowercase hex characters',
  })
  token!: string;
}
