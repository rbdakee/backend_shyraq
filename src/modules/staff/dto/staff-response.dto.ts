import { ApiProperty } from '@nestjs/swagger';

export class StaffMemberDto {
  @ApiProperty({ example: 'stf-1234-5678-abcd-1234567890ab' })
  id!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'usr-1111-2222-3333-444455556666' })
  user_id!: string;

  @ApiProperty({ example: 'Айша Нурланова', nullable: true })
  full_name!: string | null;

  @ApiProperty({ example: '+77011112233', nullable: true })
  phone!: string | null;

  @ApiProperty({
    example: 'mentor',
    enum: ['admin', 'mentor', 'specialist', 'reception'],
  })
  role!: string;

  @ApiProperty({ example: null, nullable: true })
  specialist_type!: string | null;

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({ example: '2026-01-01', nullable: true })
  hired_at!: string | null;

  @ApiProperty({ example: null, nullable: true })
  fired_at!: string | null;

  @ApiProperty({ example: null, nullable: true })
  archived_at!: string | null;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  updated_at!: string;
}
