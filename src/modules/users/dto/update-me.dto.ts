import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateMeDto {
  @ApiProperty({ example: 'Aisha Bekova', required: false, minLength: 1 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  fullName?: string;

  @ApiProperty({
    example: 'https://cdn.shyraq.app/u/abcd1234.jpg',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  avatarUrl?: string | null;

  @ApiProperty({
    example: '901231400123',
    required: false,
    nullable: true,
    description: '12-digit Kazakh IIN — must be globally unique',
  })
  @IsOptional()
  @IsString()
  @Length(12, 12)
  @Matches(/^\d{12}$/)
  iin?: string | null;

  @ApiProperty({
    example: '1990-12-31',
    required: false,
    nullable: true,
    description: 'YYYY-MM-DD',
  })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string | null;

  @ApiProperty({ example: 'kk', enum: ['kk', 'ru'], required: false })
  @IsOptional()
  @IsIn(['kk', 'ru'])
  locale?: 'kk' | 'ru';
}
