import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class CheckOutDto {
  @ApiProperty({
    example: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    description: 'Child to check out.',
  })
  @IsUUID()
  childId!: string;

  @ApiProperty({
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    description:
      'User who is picking up the child. Must be an approved active pickup guardian. 403 pickup_user_not_allowed otherwise.',
  })
  @IsUUID()
  pickupUserId!: string;

  @ApiPropertyOptional({ example: '2026-05-01T18:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  recordedAt?: string;

  @ApiPropertyOptional({ example: 'Забирает мама' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}
