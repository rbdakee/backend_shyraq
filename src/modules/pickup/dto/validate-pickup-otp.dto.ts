import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

export class ValidatePickupOtpDto {
  @ApiProperty({
    example: '123456',
    description: 'Six-digit OTP dictated by the trusted person',
    pattern: '^\\d{6}$',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}
