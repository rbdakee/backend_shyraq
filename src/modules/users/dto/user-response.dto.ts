import { ApiProperty } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ example: '00000000-0000-4000-8000-000000000001' })
  id!: string;

  @ApiProperty({ example: '+77012345678' })
  phone!: string;

  @ApiProperty({ example: 'Aisha Bekova' })
  full_name!: string;

  @ApiProperty({ nullable: true, example: null, type: String })
  avatar_url!: string | null;

  @ApiProperty({ nullable: true, example: null, type: String })
  iin!: string | null;

  @ApiProperty({
    nullable: true,
    example: null,
    type: String,
    description: 'YYYY-MM-DD or null',
  })
  date_of_birth!: string | null;

  @ApiProperty({ example: 'ru', enum: ['kk', 'ru'] })
  locale!: string;
}
