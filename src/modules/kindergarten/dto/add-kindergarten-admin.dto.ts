import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Body of `POST /saas/kindergartens/:id/admins`. Mirrors the validation of
 * `CreateKindergartenAdminDto` (the `admin` sub-object of create-kindergarten):
 * snake_case input, E.164 phone, optional ru/kk locale (defaults to ru).
 */
export class AddKindergartenAdminDto {
  @ApiProperty({
    example: 'Жанна Серикова',
    description: 'Admin full name.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  full_name!: string;

  @ApiProperty({
    example: '+77011115566',
    description: 'Admin phone — E.164 format. Used to find-or-create the user.',
  })
  @IsString()
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'invalid_phone_format' })
  phone!: string;

  @ApiPropertyOptional({
    example: 'kk',
    enum: ['ru', 'kk'],
    description: 'Preferred locale for invite SMS and UI. Defaults to ru.',
  })
  @IsOptional()
  @IsIn(['ru', 'kk'])
  locale?: 'ru' | 'kk';
}
