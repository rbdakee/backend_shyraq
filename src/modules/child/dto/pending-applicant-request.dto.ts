import { ApiProperty } from '@nestjs/swagger';

/** Kindergarten name nested in the applicant-request response. */
export class PendingRequestKindergartenDto {
  @ApiProperty({
    example: 'Балапан',
    description: 'Display name of the kindergarten the request targets.',
  })
  name!: string;
}

/**
 * APPLICANT-perspective view of one of the caller's own `link` requests that
 * is still awaiting approval. PII of the child is intentionally hidden until
 * the primary guardian approves the link — only a masked name is exposed
 * (no IIN / date-of-birth / photo / group).
 */
export class PendingApplicantRequestDto {
  @ApiProperty({
    example: '66666666-6666-6666-6666-666666666666',
    description: 'Guardian row id (track approval state with it).',
  })
  id!: string;

  @ApiProperty({
    enum: ['secondary', 'nanny'],
    example: 'secondary',
    description: 'Requested guardian role.',
  })
  role!: string;

  @ApiProperty({
    example: false,
    description: 'Whether the request asks for pickup rights.',
  })
  can_pickup!: boolean;

  @ApiProperty({
    enum: ['pending_approval'],
    example: 'pending_approval',
    description: 'Always `pending_approval` for this endpoint.',
  })
  status!: 'pending_approval';

  @ApiProperty({
    example: 'А****',
    description:
      'Masked child name (first letter of each word + ****). Full child PII ' +
      'stays hidden until the primary guardian approves the link.',
  })
  child_name_masked!: string;

  @ApiProperty({ type: PendingRequestKindergartenDto })
  kindergarten!: PendingRequestKindergartenDto;

  @ApiProperty({
    example: '2026-06-01T09:15:00.000Z',
    description: 'When the link request was created (ISO 8601).',
  })
  created_at!: string;
}
