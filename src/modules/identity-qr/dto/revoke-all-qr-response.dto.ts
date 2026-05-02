import { ApiProperty } from '@nestjs/swagger';

export class RevokeAllQrResponseDto {
  @ApiProperty({
    example: 1,
    description:
      'Number of previously-active QR token rows just stamped revoked_at. Returns 0 when the user had no active tokens.',
  })
  revokedCount!: number;
}
