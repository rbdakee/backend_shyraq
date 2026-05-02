import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shape for `GET /users/me/qr`. The plaintext `token` is the only
 * place in the system where the QR value is exposed — it lives in Redis under
 * `qr:token:{plaintext} → user_id` for staff scans, and in `user_qr_tokens`
 * only as a SHA-256 hash. Once the response is delivered, the server cannot
 * retrieve the plaintext again.
 */
export class GetMyQrResponseDto {
  @ApiProperty({
    example: '2f1d4a9b6c7e8f0123456789abcdef01',
    description:
      'Opaque 32-char lowercase-hex token (16 random bytes). Plaintext — render as QR client-side.',
  })
  token!: string;

  @ApiProperty({
    example: '2026-05-01T09:00:00.000Z',
    description: 'ISO-8601 timestamp when this token was minted.',
  })
  issuedAt!: string;

  @ApiProperty({
    example: '2026-05-02T09:00:00.000Z',
    description:
      'ISO-8601 timestamp when this token expires (24h after issuedAt).',
  })
  expiresAt!: string;
}
