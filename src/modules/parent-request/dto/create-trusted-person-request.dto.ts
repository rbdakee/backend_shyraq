import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PHONE_REGEX = /^\+[1-9]\d{10,14}$/;
const IIN_REGEX = /^\d{12}$/;
const CODE_REGEX = /^\d{6}$/;

/**
 * Body shape for `POST /parent/requests/trusted-person`. Validates the OTP in
 * the same ambient TX as the parent_request insert — wrong/expired/locked
 * code surfaces the auth module's OtpInvalid/OtpExpired/OtpLocked errors so
 * client behaviour is consistent with login OTP.
 */
export class CreateTrustedPersonRequestDto {
  @ApiProperty({
    example: '123456',
    description: '6-digit code from the SMS sent by /otp-request.',
  })
  @IsString()
  @Matches(CODE_REGEX, { message: 'code must be exactly 6 digits' })
  code!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({
    example: 'Айгуль Бекмаганбетова',
    minLength: 2,
    maxLength: 200,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  full_name!: string;

  @ApiProperty({ example: '+77071234567' })
  @IsString()
  @Matches(PHONE_REGEX, {
    message:
      'phone must be in E.164 format (+ followed by 11–15 digits, no spaces)',
  })
  phone!: string;

  @ApiProperty({
    example: '880101400123',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(IIN_REGEX, { message: 'iin must be exactly 12 digits' })
  iin?: string | null;

  @ApiProperty({
    example: 'aunt',
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @Length(1, 64)
  relation!: string;

  @ApiProperty({
    example: 'https://cdn.example.com/photos/aunt.jpg',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  photo_url?: string | null;

  @ApiProperty({ example: false, default: false, required: false })
  @IsOptional()
  @IsBoolean()
  is_one_time?: boolean;

  @ApiProperty({
    example: false,
    default: false,
    required: false,
    description:
      'When true, an immediate pickup_request is created on accept linked via parent_request_id.',
  })
  @IsOptional()
  @IsBoolean()
  create_pickup_request?: boolean;

  @ApiProperty({
    example: 'Прошу добавить тётю в доверенные лица.',
    nullable: true,
    required: false,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string | null;
}
