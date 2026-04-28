import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateKindergartenAdminDto {
  @ApiProperty({
    example: 'Айгерим Нурланкызы',
    description: 'Admin full name.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  full_name!: string;

  @ApiProperty({
    example: '+77011112233',
    description: 'Admin phone — E.164 format.',
  })
  @IsString()
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'invalid_phone_format' })
  phone!: string;

  @ApiPropertyOptional({
    example: 'ru',
    enum: ['ru', 'kk'],
    description: 'Preferred locale for welcome SMS and UI. Defaults to ru.',
  })
  @IsOptional()
  @IsIn(['ru', 'kk'])
  locale?: 'ru' | 'kk';
}

export class CreateKindergartenDto {
  @ApiProperty({
    example: 'Солнышко',
    description: 'Kindergarten display name.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiProperty({
    example: 'solnyshko',
    description:
      'Unique slug — lower-case a-z/0-9 with single hyphens between segments.',
  })
  @IsString()
  @Matches(/^[a-z0-9](-?[a-z0-9])*$/, { message: 'invalid_slug_format' })
  @MaxLength(64)
  slug!: string;

  @ApiPropertyOptional({
    example: 'Алматы, ул. Абая, 1',
    description: 'Street address.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({
    example: '+77272221100',
    description: 'Kindergarten contact phone (E.164).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\+[1-9]\d{1,14}$/, { message: 'invalid_phone_format' })
  phone?: string;

  @ApiPropertyOptional({
    example: 'standard',
    description: 'Tariff plan code. Defaults to standard.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  plan?: string;

  @ApiPropertyOptional({
    example: { timezone: 'Asia/Almaty', currency: 'KZT' },
    description:
      'Free-form JSONB settings bag. Fiscal keys (fiscal_*) allowed only via SuperAdmin.',
  })
  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;

  @ApiProperty({
    type: CreateKindergartenAdminDto,
    description:
      'First kindergarten admin — resolved by phone (reused if user exists).',
  })
  @ValidateNested()
  @Type(() => CreateKindergartenAdminDto)
  admin!: CreateKindergartenAdminDto;
}
