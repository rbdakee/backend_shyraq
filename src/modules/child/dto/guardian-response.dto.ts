import { ApiProperty } from '@nestjs/swagger';

export class GuardianDto {
  @ApiProperty({ example: '66666666-6666-6666-6666-666666666666' })
  id!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' })
  child_id!: string;

  @ApiProperty({ example: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' })
  user_id!: string;

  @ApiProperty({
    example: 'Алия Бекова',
    nullable: true,
    description:
      'Display name resolved from the linked `users` row (users.full_name). ' +
      'null when the phone-invited user has not filled in their profile yet.',
  })
  user_full_name!: string | null;

  @ApiProperty({
    example: '+77011223344',
    nullable: true,
    description:
      'Phone (E.164) resolved from the linked `users` row (users.phone). ' +
      'null when unavailable.',
  })
  user_phone!: string | null;

  @ApiProperty({ enum: ['primary', 'secondary', 'nanny'] })
  role!: 'primary' | 'secondary' | 'nanny';

  @ApiProperty({
    enum: ['pending_approval', 'approved', 'rejected', 'revoked'],
  })
  status!: 'pending_approval' | 'approved' | 'rejected' | 'revoked';

  @ApiProperty({ example: false })
  has_approval_rights!: boolean;

  @ApiProperty({ example: true })
  can_pickup!: boolean;

  @ApiProperty({
    example: { view_cctv: false },
    additionalProperties: { type: 'boolean' },
  })
  permissions!: Record<string, boolean>;

  @ApiProperty({ nullable: true })
  approved_by!: string | null;

  @ApiProperty({ nullable: true })
  approved_at!: string | null;

  @ApiProperty({ nullable: true })
  revoked_by!: string | null;

  @ApiProperty({ nullable: true })
  revoked_at!: string | null;

  @ApiProperty({ nullable: true })
  permissions_updated_by!: string | null;

  @ApiProperty({ nullable: true })
  permissions_updated_at!: string | null;

  @ApiProperty({ example: '2026-04-26T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-04-26T10:00:00.000Z' })
  updated_at!: string;
}

export class EffectivePermissionsDto {
  @ApiProperty({ enum: ['primary', 'secondary', 'nanny'] })
  role!: string;

  @ApiProperty({
    description:
      'Full effective permissions map (defaults overlaid by overrides).',
    additionalProperties: { type: 'boolean' },
  })
  effective!: Record<string, boolean>;

  @ApiProperty({
    description: 'Subset of overrides that diverge from the role defaults.',
    additionalProperties: { type: 'boolean' },
  })
  overrides!: Record<string, boolean>;

  @ApiProperty({ example: true })
  can_pickup!: boolean;

  @ApiProperty({ example: false })
  has_approval_rights!: boolean;
}

export class ChildGroupHistoryDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  child_id!: string;
  @ApiProperty({ nullable: true })
  from_group_id!: string | null;
  @ApiProperty({ nullable: true })
  to_group_id!: string | null;
  @ApiProperty()
  transferred_at!: string;
  @ApiProperty()
  transferred_by_staff_id!: string;
  @ApiProperty({ nullable: true })
  reason!: string | null;
}
