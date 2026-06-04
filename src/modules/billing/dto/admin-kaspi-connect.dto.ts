import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

// ─── Request DTOs ─────────────────────────────────────────────────────────

export class KaspiSendPhoneDto {
  @ApiProperty({
    example: 'e1b2c3d4-0000-0000-0000-000000000000',
    description: 'Process id returned by POST /admin/kaspi/connect/init.',
  })
  @IsString()
  process_id!: string;

  @ApiProperty({
    example: '77011234567',
    description:
      "Cashier phone in Kaspi's 11-digit format (7XXXXXXXXXX). Triggers a real SMS.",
  })
  @Matches(/^7\d{10}$/, {
    message: 'invalid_phone_format',
  })
  phone!: string;
}

export class KaspiVerifyOtpDto {
  @ApiProperty({
    example: 'e1b2c3d4-0000-0000-0000-000000000000',
    description: 'Process id returned by POST /admin/kaspi/connect/init.',
  })
  @IsString()
  process_id!: string;

  @ApiProperty({
    example: '123456',
    description: 'The 6-digit SMS code the cashier received.',
  })
  @Matches(/^\d{4,6}$/, { message: 'invalid_otp_format' })
  otp!: string;
}

// ─── Response DTOs ────────────────────────────────────────────────────────

export class KaspiInitResponseDto {
  @ApiProperty({
    example: 'e1b2c3d4-0000-0000-0000-000000000000',
    description:
      'Opaque Kaspi process id — pass it to send-phone and verify-otp.',
  })
  process_id!: string;
}

export class KaspiSendPhoneResponseDto {
  @ApiProperty({ example: 'e1b2c3d4-0000-0000-0000-000000000000' })
  process_id!: string;

  @ApiProperty({
    example: true,
    description: 'True when Kaspi accepted the phone and dispatched the SMS.',
  })
  sms_sent!: boolean;
}

export class KaspiVerifyOtpResponseDto {
  @ApiProperty({ example: true })
  connected!: boolean;

  @ApiProperty({
    example: '77011234567',
    description: 'The connected cashier phone.',
  })
  phone!: string;

  @ApiProperty({
    example: 'ТОО Солнышко',
    description: 'Organization name resolved from Kaspi org-context.',
    nullable: true,
  })
  org_name!: string | null;

  @ApiProperty({
    example: '482931',
    description: 'Kaspi merchant profile id.',
    nullable: true,
  })
  profile_id!: string | null;
}

export class KaspiStatusResponseDto {
  @ApiProperty({
    example: true,
    description: 'True only when the session status is `active`.',
  })
  connected!: boolean;

  @ApiProperty({
    example: 'active',
    description:
      'Session status: pending | active | expired | revoked | disconnected (no row).',
    enum: ['pending', 'active', 'expired', 'revoked', 'disconnected'],
  })
  status!: string;

  @ApiProperty({
    example: '77011234567',
    description: 'Connected cashier phone (omitted when never connected).',
    required: false,
  })
  phone?: string;

  @ApiProperty({
    example: 'ТОО Солнышко',
    description: 'Organization name (omitted when never connected).',
    required: false,
  })
  org_name?: string;

  @ApiProperty({
    example: '2026-06-04T12:00:00.000Z',
    description: 'Last time the session was checked/refreshed (ISO-8601).',
    required: false,
  })
  last_checked_at?: Date;
}

export class KaspiDisconnectResponseDto {
  @ApiProperty({ example: 'revoked', enum: ['revoked'] })
  status!: 'revoked';
}
