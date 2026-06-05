import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl } from 'class-validator';

// ─── Response DTO ────────────────────────────────────────────────────────────

export class KaspiGlobalConfigResponseDto {
  @ApiProperty({
    example: '4.110.1',
    description:
      'Kaspi app version string (cosmetic, does not affect the gate).',
  })
  app_version!: string;

  @ApiProperty({
    example: '1076',
    description:
      'Kaspi app build number (key gate field — Kaspi rejects builds below the rolling floor).',
  })
  app_build!: string;

  @ApiProperty({
    example: '18.5',
    description: 'iOS platform version used in Cookie and request body.',
  })
  platform_ver!: string;

  @ApiProperty({
    example: 'iPhone17,3',
    description: 'Device model identifier sent in the Kaspi request body.',
  })
  model!: string;

  @ApiProperty({
    example: 'Apple',
    description: 'Device brand sent in the Kaspi request body.',
  })
  brand!: string;

  @ApiProperty({
    example: 'Kaspi%20Pay/1076 CFNetwork/3826.500.131 Darwin/24.5.0',
    description: 'Native Kaspi app User-Agent string.',
  })
  ua_native!: string;

  @ApiProperty({
    example:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    description: 'Browser/WebView User-Agent string sent in HTTP headers.',
  })
  ua_browser!: string;

  @ApiProperty({
    example: 'https://entrance-pay.kaspi.kz',
    description: 'Base URL for the Kaspi entrance (login / onboarding) API.',
  })
  entrance_url!: string;

  @ApiProperty({
    example: 'https://mtoken.kaspi.kz',
    description: 'Base URL for the Kaspi mtoken (session token) API.',
  })
  mtoken_url!: string;

  @ApiProperty({
    example: 'https://qrpay.kaspi.kz',
    description: 'Base URL for the Kaspi QR-pay API.',
  })
  qrpay_url!: string;

  @ApiProperty({
    example: '00000000-0000-0000-0000-000000000001',
    description:
      'UUID of the super-admin who last edited this config. Null if never updated.',
    nullable: true,
  })
  updated_by!: string | null;

  @ApiProperty({
    example: '2026-06-01T12:00:00.000Z',
    description: 'Timestamp of the last update (ISO-8601).',
  })
  updated_at!: Date;
}

// ─── PUT body DTO ─────────────────────────────────────────────────────────────

export class UpdateKaspiGlobalConfigDto {
  @ApiProperty({
    example: '4.111.0',
    description: 'Kaspi app version string.',
    required: false,
  })
  @IsOptional()
  @IsString()
  app_version?: string;

  @ApiProperty({
    example: '1077',
    description:
      'Kaspi app build number — raise this when Kaspi blocks with OldVersionToUpdate.',
    required: false,
  })
  @IsOptional()
  @IsString()
  app_build?: string;

  @ApiProperty({
    example: '18.5',
    description: 'iOS platform version.',
    required: false,
  })
  @IsOptional()
  @IsString()
  platform_ver?: string;

  @ApiProperty({
    example: 'iPhone17,3',
    description: 'Device model identifier.',
    required: false,
  })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiProperty({
    example: 'Apple',
    description: 'Device brand.',
    required: false,
  })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiProperty({
    example: 'Kaspi%20Pay/1077 CFNetwork/3826.500.131 Darwin/24.5.0',
    description: 'Native Kaspi app User-Agent string.',
    required: false,
  })
  @IsOptional()
  @IsString()
  ua_native?: string;

  @ApiProperty({
    example:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    description: 'Browser/WebView User-Agent string.',
    required: false,
  })
  @IsOptional()
  @IsString()
  ua_browser?: string;

  @ApiProperty({
    example: 'https://entrance-pay.kaspi.kz',
    description: 'Base URL for the Kaspi entrance API.',
    required: false,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  entrance_url?: string;

  @ApiProperty({
    example: 'https://mtoken.kaspi.kz',
    description: 'Base URL for the Kaspi mtoken API.',
    required: false,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  mtoken_url?: string;

  @ApiProperty({
    example: 'https://qrpay.kaspi.kz',
    description: 'Base URL for the Kaspi QR-pay API.',
    required: false,
  })
  @IsOptional()
  @IsUrl({ require_tld: false })
  qrpay_url?: string;
}

// ─── Version-probe DTOs ────────────────────────────────────────────────────

export class KaspiVersionProbeDto {
  @ApiProperty({
    example: '1077',
    description:
      'App build to test against Kaspi gate. Defaults to current config `app_build`.',
    required: false,
  })
  @IsOptional()
  @IsString()
  app_build?: string;

  @ApiProperty({
    example: '4.111.0',
    description:
      'App version to test. Defaults to current config `app_version`.',
    required: false,
  })
  @IsOptional()
  @IsString()
  app_version?: string;
}

export class KaspiVersionProbeResponseDto {
  @ApiProperty({
    example: '1077',
    description: 'The app_build that was probed.',
  })
  build!: string;

  @ApiProperty({
    example: true,
    description:
      'True if Kaspi accepted the build (phone-entry view appeared). False if blocked or unexpected response.',
  })
  accepted!: boolean;

  @ApiProperty({
    example: 'OldVersionToUpdate',
    description:
      'Present only when Kaspi actively blocked the build with OldVersionToUpdate.',
    required: false,
    nullable: true,
  })
  alarm?: 'OldVersionToUpdate';
}
