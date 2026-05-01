import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PushTokenResponseDto {
  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'UUID of the push_tokens row.',
  })
  id!: string;

  @ApiProperty({
    example: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    description: 'UUID of the owning user.',
  })
  user_id!: string;

  @ApiProperty({
    example: 'dGhpc0lzQUZha2VGY21Ub2tlbjEyMzQ1Njc4OTAxMjM0NTY3ODkw',
    description: 'The device token as registered.',
  })
  token!: string;

  @ApiProperty({
    enum: ['ios', 'android', 'web'],
    example: 'android',
    description: 'Device platform.',
  })
  platform!: string;

  @ApiPropertyOptional({
    example: '2.4.1',
    description: 'App version at time of last registration.',
    nullable: true,
  })
  app_version!: string | null;

  @ApiPropertyOptional({
    example: 'device-uuid-abc123',
    description: 'Device identifier.',
    nullable: true,
  })
  device_id!: string | null;

  @ApiProperty({
    example: '2026-05-01T10:00:00.000Z',
    description: 'Last time this token was seen / registered.',
  })
  last_seen_at!: string;

  @ApiProperty({
    example: '2026-04-01T08:00:00.000Z',
    description: 'When the token row was first created.',
  })
  created_at!: string;
}
