import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PHONE_REGEX = /^\+[1-9]\d{10,14}$/;
const IIN_REGEX = /^\d{12}$/;

/**
 * Body shape for `POST /parent/children/:id/trusted-people`. Wire keys
 * are snake_case per the project endpoints.md convention; the controller
 * maps to camelCase service-layer types via local destructuring.
 */
export class AddTrustedPersonDto {
  @ApiProperty({
    example: 'Айгуль Бекмаганбетова',
    description: 'Full name of the trusted person',
    minLength: 2,
    maxLength: 200,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  full_name!: string;

  @ApiProperty({
    example: '+77071234567',
    description: 'E.164 phone number (used for OTP delivery)',
  })
  @IsString()
  @Matches(PHONE_REGEX, {
    message:
      'phone must be in E.164 format (+ followed by 11–15 digits, no spaces)',
  })
  phone!: string;

  @ApiProperty({
    example: '880101400123',
    description: 'Optional 12-digit Kazakh IIN',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  @Matches(IIN_REGEX, { message: 'iin must be exactly 12 digits' })
  iin?: string | null;

  @ApiProperty({
    example: 'aunt',
    description:
      'Relation label (free-form short string — e.g. aunt, neighbor, driver)',
    minLength: 1,
    maxLength: 64,
  })
  @IsString()
  @Length(1, 64)
  relation!: string;

  @ApiProperty({
    example: 'https://cdn.example.com/photos/aunt.jpg',
    description: 'Optional photo URL of the trusted person',
    nullable: true,
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  photo_url?: string | null;

  @ApiProperty({
    example: false,
    description:
      'When true, the row auto-deactivates after a single successful pickup',
    default: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  is_one_time?: boolean;
}
