import { ApiProperty } from '@nestjs/swagger';

export class KindergartenDto {
  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  id!: string;

  @ApiProperty({ example: 'Солнышко' })
  name!: string;

  @ApiProperty({ example: 'solnyshko' })
  slug!: string;

  @ApiProperty({ example: 'Алматы, ул. Абая, 1', nullable: true, type: String })
  address!: string | null;

  @ApiProperty({ example: '+77272221100', nullable: true, type: String })
  phone!: string | null;

  @ApiProperty({ example: 'standard' })
  plan!: string;

  @ApiProperty({
    example: { timezone: 'Asia/Almaty', currency: 'KZT' },
    type: Object,
  })
  settings!: Record<string, unknown>;

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({
    example: null,
    nullable: true,
    type: String,
    description: 'ISO-8601 archive timestamp; null when active.',
  })
  archived_at!: string | null;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  updated_at!: string;
}

export class CreatedKindergartenStaffDto {
  @ApiProperty({ example: 'e2e2b6a7-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  id!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'd3e2b6a7-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  user_id!: string;

  @ApiProperty({ example: 'admin', enum: ['admin'] })
  role!: 'admin';

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({ example: '2026-04-28', nullable: true, type: String })
  hired_at!: string | null;
}

export class CreatedKindergartenUserDto {
  @ApiProperty({ example: 'd3e2b6a7-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  id!: string;

  @ApiProperty({ example: '+77011112233' })
  phone!: string;

  @ApiProperty({ example: 'Айгерим Нурланкызы' })
  full_name!: string;

  @ApiProperty({ example: 'ru', enum: ['ru', 'kk'] })
  locale!: string;
}

export class CreateKindergartenResponseDto {
  @ApiProperty({ type: KindergartenDto })
  kindergarten!: KindergartenDto;

  @ApiProperty({ type: CreatedKindergartenStaffDto })
  staff_member!: CreatedKindergartenStaffDto;

  @ApiProperty({ type: CreatedKindergartenUserDto })
  user!: CreatedKindergartenUserDto;
}

export class KindergartenListResponseDto {
  @ApiProperty({ type: [KindergartenDto] })
  items!: KindergartenDto[];

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}

export class InviteAdminResponseDto {
  @ApiProperty({ example: '+77011112233' })
  phone!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({
    example: true,
    description:
      'true if the SMS adapter accepted the message. false means the adapter rejected it but the request still succeeded (best-effort semantics).',
  })
  sent!: boolean;
}
