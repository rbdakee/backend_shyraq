import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';

export class LinkChildDto {
  @ApiProperty({
    example: '001122334455',
    description: 'Kazakhstani 12-digit IIN of the child.',
  })
  @IsString()
  @Matches(/^\d{12}$/)
  iin!: string;

  @ApiProperty({
    enum: ['secondary', 'nanny'],
    example: 'secondary',
    description:
      "Desired guardian role. 'primary' is reserved for enrollment flow.",
  })
  @IsEnum(['secondary', 'nanny'])
  role!: 'secondary' | 'nanny';

  @ApiPropertyOptional({
    example: false,
    description:
      'Whether the guardian is allowed to pick the child up. Defaults to false. Takes effect after approval.',
  })
  @IsOptional()
  @IsBoolean()
  can_pickup?: boolean;
}
