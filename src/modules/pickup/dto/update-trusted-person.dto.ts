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
 * Patch shape for `PATCH /parent/trusted-people/:id`. All fields optional.
 * `isActive` is intentionally NOT here — revoking a trusted person goes
 * through `POST /parent/trusted-people/:id/revoke` so the audit timestamp
 * (`revoked_at`) is set deterministically.
 */
export class UpdateTrustedPersonDto {
  @ApiProperty({
    example: 'Айгуль Б.',
    required: false,
    minLength: 2,
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  fullName?: string;

  @ApiProperty({ example: '+77071234567', required: false })
  @IsOptional()
  @IsString()
  @Matches(PHONE_REGEX, {
    message:
      'phone must be in E.164 format (+ followed by 11–15 digits, no spaces)',
  })
  phone?: string;

  @ApiProperty({ example: '880101400123', required: false, nullable: true })
  @IsOptional()
  @IsString()
  @Matches(IIN_REGEX, { message: 'iin must be exactly 12 digits' })
  iin?: string | null;

  @ApiProperty({ example: 'driver', required: false })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  relation?: string;

  @ApiProperty({
    example: 'https://cdn.example.com/photos/aunt.jpg',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  photoUrl?: string | null;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isOneTime?: boolean;
}
