import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export type PushPlatform = 'ios' | 'android' | 'web';

export class RegisterPushTokenDto {
  @ApiProperty({
    example: 'dGhpc0lzQUZha2VGY21Ub2tlbjEyMzQ1Njc4OTAxMjM0NTY3ODkw',
    description: 'FCM/APNS device token (max 512 chars).',
    minLength: 1,
    maxLength: 512,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  token!: string;

  @ApiProperty({
    enum: ['ios', 'android', 'web'],
    example: 'android',
    description: 'Device platform.',
  })
  @IsEnum(['ios', 'android', 'web'])
  platform!: PushPlatform;

  @ApiPropertyOptional({
    example: '2.4.1',
    description: 'App version string (max 32 chars).',
    maxLength: 32,
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  app_version?: string;

  @ApiPropertyOptional({
    example: 'device-uuid-abc123',
    description: 'Stable device identifier (max 128 chars).',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  device_id?: string;
}
