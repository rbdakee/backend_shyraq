import { ApiProperty } from '@nestjs/swagger';

/**
 * One guardian on the staff-facing child card. `relation` is the guardian
 * `role` (`primary|secondary|nanny`) surfaced directly — the DB has no separate
 * familial-relation field. `full_name` / `phone` are overlaid from the linked
 * `users` identity, mirroring the admin child card.
 */
export class ChildCardGuardianDto {
  @ApiProperty({
    example: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    description: 'Guardian user id (users.id).',
  })
  user_id!: string;

  @ApiProperty({
    example: 'Айгүл Серикова',
    nullable: true,
    description: 'Guardian display name (from the linked users row), or null.',
  })
  full_name!: string | null;

  @ApiProperty({
    example: 'primary',
    enum: ['primary', 'secondary', 'nanny'],
    description: 'Guardian role surfaced as the relation.',
  })
  relation!: string;

  @ApiProperty({
    example: '+77011234567',
    nullable: true,
    description: 'Guardian phone (from the linked users row), or null.',
  })
  phone!: string | null;

  @ApiProperty({
    example: true,
    description: 'Whether the guardian is authorized to pick up the child.',
  })
  can_pickup!: boolean;
}

/**
 * Full staff-facing child card (`GET /staff/children/:id`): identity, group,
 * health info and the approved guardians list. Kindergarten-scoped — any staff
 * member of the child's kg may read it.
 */
export class ChildCardResponseDto {
  @ApiProperty({
    example: 'c3b30bb7-0000-0000-0000-000000000001',
    description: 'Child id.',
  })
  id!: string;

  @ApiProperty({ example: 'Алихан Сериков', description: 'Child full name.' })
  full_name!: string;

  @ApiProperty({
    example: '2020-06-14',
    description: 'Date of birth (YYYY-MM-DD).',
  })
  date_of_birth!: string;

  @ApiProperty({
    example: 'https://cdn.example.com/media/kg/2026-06/abc.jpg',
    nullable: true,
    description: 'Child photo URL (presigned on read), or null.',
  })
  photo_url!: string | null;

  @ApiProperty({
    example: 'a1b2c3d4-0000-0000-0000-000000000001',
    nullable: true,
    description: 'Current group id, or null.',
  })
  current_group_id!: string | null;

  @ApiProperty({
    example: 'Күншуақ',
    nullable: true,
    description: 'Current group display name (overlay), or null.',
  })
  group_name!: string | null;

  @ApiProperty({
    type: [String],
    example: ['Орехи'],
    description:
      'Allergies. The DB stores a single free-text `allergy_notes`; it is ' +
      'surfaced here as a single-element array (empty when unset).',
  })
  allergies!: string[];

  @ApiProperty({
    example: 'Поллиноз весной',
    nullable: true,
    description: 'Free-text medical notes, or null.',
  })
  medical_notes!: string | null;

  @ApiProperty({ type: [ChildCardGuardianDto] })
  guardians!: ChildCardGuardianDto[];
}
