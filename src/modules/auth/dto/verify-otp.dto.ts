import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class VerifyOtpDto {
  @ApiProperty({
    description: 'Phone the OTP was issued for',
    example: '+77012345678',
  })
  @IsString()
  @Matches(/^\+7\d{10}$/, { message: 'phone must be E.164 +7XXXXXXXXXX' })
  phone!: string;

  @ApiProperty({
    description: 'Six-digit numeric OTP delivered via SMS',
    example: '123456',
    minLength: 6,
    maxLength: 6,
  })
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits' })
  code!: string;
}
