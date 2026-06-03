import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { AUTH_APPS, AuthApp } from './request-otp.dto';

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

  @ApiProperty({
    description:
      'Which client app the login targets. Roles are filtered by this audience ' +
      'BEFORE the role resolve. `role` is NOT accepted here — it is derived.',
    example: 'parent',
    enum: AUTH_APPS,
  })
  @IsIn(AUTH_APPS, { message: 'app must be one of parent|staff|admin' })
  app!: AuthApp;

  @ApiProperty({
    description:
      'Optional kindergarten id (staff/admin only). When supplied and it matches ' +
      'one of the filtered active staff roles, the multi-kg select step is skipped ' +
      'and a full token pair is issued directly for that kindergarten.',
    example: '5b3d3b8a-7f4f-4d2a-9c84-9a7c1c1c1c1c',
    required: false,
    nullable: true,
    type: String,
  })
  @IsOptional()
  @IsUUID()
  kindergartenId?: string;
}
