import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class UpdateSettingsDto {
  @ApiProperty({
    example: {
      timezone: 'Asia/Almaty',
      currency: 'KZT',
      late_pickup_fee_amount: 500,
    },
    description:
      'Full settings bag — replaces the existing one. Keys starting with fiscal_ are rejected with HTTP 403 on this endpoint; SuperAdmin can set them via the SaaS surface.',
    type: Object,
  })
  @IsObject()
  settings!: Record<string, unknown>;
}
