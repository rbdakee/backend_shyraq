import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const MAC_COMPONENT_PATTERN = /^[0-9A-Fa-f]{32}$/;
const TERMINAL_PATTERN = /^[0-9A-Za-z]{1,64}$/;

export class UpsertBccAccountDto {
  @ApiProperty({ example: 'SHYRAQ_TEST_MERCHANT' })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  merchant_id!: string;

  @ApiProperty({ example: '88888881' })
  @IsString()
  @Matches(TERMINAL_PATTERN)
  terminal_id!: string;

  @ApiPropertyOptional({ example: 'Shyraq Test' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  merchant_name?: string;

  @ApiProperty({ enum: ['test', 'live'], example: 'test' })
  @IsEnum(['test', 'live'])
  environment!: 'test' | 'live';

  @ApiProperty({
    example: '690B5589573ACB3608DB7395A319B175',
    description: 'First 16-byte HEX component. Never persisted.',
  })
  @IsString()
  @Matches(MAC_COMPONENT_PATTERN)
  mac_key_component_1!: string;

  @ApiProperty({
    example: '02BBF98BB3411445D15498E2DC22E3E1',
    description: 'Second 16-byte HEX component. Never persisted.',
  })
  @IsString()
  @Matches(MAC_COMPONENT_PATTERN)
  mac_key_component_2!: string;
}

export class RotateBccMacDto {
  @ApiProperty({
    example: '690B5589573ACB3608DB7395A319B175',
    description: 'First 16-byte HEX component. Never persisted.',
  })
  @IsString()
  @Matches(MAC_COMPONENT_PATTERN)
  mac_key_component_1!: string;

  @ApiProperty({
    example: '02BBF98BB3411445D15498E2DC22E3E1',
    description: 'Second 16-byte HEX component. Never persisted.',
  })
  @IsString()
  @Matches(MAC_COMPONENT_PATTERN)
  mac_key_component_2!: string;
}

export class BccConnectionResultDto {
  @ApiProperty({ example: true })
  success!: boolean;

  @ApiProperty({ example: '0', nullable: true })
  action!: string | null;

  @ApiProperty({ example: '00', nullable: true })
  rc!: string | null;

  @ApiProperty({ example: 'APPROVED', nullable: true })
  rc_text!: string | null;
}

export class BccAccountResponseDto {
  @ApiProperty({ example: true })
  connected!: boolean;

  @ApiProperty({ enum: ['draft', 'active', 'disabled'], example: 'active' })
  status!: 'draft' | 'active' | 'disabled';

  @ApiProperty({ example: 'SHYRAQ_TEST_MERCHANT' })
  merchant_id!: string;

  @ApiProperty({ example: '88888881' })
  terminal_id!: string;

  @ApiProperty({ example: 'Shyraq Test', nullable: true })
  merchant_name!: string | null;

  @ApiProperty({ enum: ['test', 'live'], example: 'test' })
  environment!: 'test' | 'live';

  @ApiProperty({
    example: '2026-07-06T04:30:00.000Z',
    nullable: true,
  })
  last_connection_checked_at!: string | null;

  @ApiProperty({
    type: BccConnectionResultDto,
    nullable: true,
  })
  last_connection_result!: BccConnectionResultDto | null;
}

export class BccAccountProvisioningResponseDto extends BccAccountResponseDto {
  @ApiPropertyOptional({
    example:
      'https://balam-api-dev.innodev.kz:443/api/v1/webhooks/payments/bcc/one-time-token',
    description: 'Returned only when callback credentials are first created.',
  })
  notify_url?: string;

  @ApiPropertyOptional({
    example: 'bcc_30f6e124d82b2e8b0671654b',
    description: 'Returned only when callback credentials are first created.',
  })
  notify_username?: string;

  @ApiPropertyOptional({
    example: 'one-time-random-password',
    description: 'Returned once. It cannot be recovered through GET.',
  })
  notify_password?: string;
}

export class BccConnectionCheckResponseDto {
  @ApiProperty({ example: true })
  connected!: boolean;

  @ApiProperty({ enum: ['draft', 'active', 'disabled'], example: 'active' })
  status!: 'draft' | 'active' | 'disabled';

  @ApiProperty({ example: '2026-07-06T04:30:00.000Z' })
  checked_at!: string;

  @ApiProperty({ type: BccConnectionResultDto })
  result!: BccConnectionResultDto;
}

export class BccDisableResponseDto {
  @ApiProperty({ enum: ['disabled'], example: 'disabled' })
  status!: 'disabled';
}

export class BccCallbackCredentialsResponseDto {
  @ApiProperty({
    example:
      'https://balam-api-dev.innodev.kz:443/api/v1/webhooks/payments/bcc/one-time-token',
  })
  notify_url!: string;

  @ApiProperty({ example: 'bcc_30f6e124d82b2e8b0671654b' })
  notify_username!: string;

  @ApiProperty({
    example: 'one-time-random-password',
    description: 'Returned once. It cannot be recovered through GET.',
  })
  notify_password!: string;
}
