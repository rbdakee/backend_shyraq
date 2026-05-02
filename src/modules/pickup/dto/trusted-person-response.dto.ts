import { ApiProperty } from '@nestjs/swagger';

export class TrustedPersonResponseDto {
  @ApiProperty({ example: '22222222-3333-4444-5555-666666666666' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  child_id!: string;

  @ApiProperty({ example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  added_by_user_id!: string;

  @ApiProperty({ example: 'Айгуль Бекмаганбетова' })
  full_name!: string;

  @ApiProperty({ example: '+77071234567' })
  phone!: string;

  @ApiProperty({ example: '880101400123', nullable: true })
  iin!: string | null;

  @ApiProperty({ example: 'aunt' })
  relation!: string;

  @ApiProperty({
    example: 'https://cdn.example.com/photos/aunt.jpg',
    nullable: true,
  })
  photo_url!: string | null;

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({ example: false })
  is_one_time!: boolean;

  @ApiProperty({ example: null, nullable: true })
  used_at!: string | null;

  @ApiProperty({ example: '2026-05-01T09:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: null, nullable: true })
  revoked_at!: string | null;
}
