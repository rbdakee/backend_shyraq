import { ApiProperty } from '@nestjs/swagger';

export class ParentRequestMessageResponseDto {
  @ApiProperty({ example: 'mmmmmmmm-1111-2222-3333-mmmmmmmmmmmm' })
  id!: string;

  @ApiProperty({ example: '00000000-0000-0000-0000-000000000001' })
  kindergarten_id!: string;

  @ApiProperty({ example: '11111111-2222-3333-4444-555555555555' })
  parent_request_id!: string;

  @ApiProperty({
    example: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    nullable: true,
    description:
      'Author user id when the message is from the parent. XOR with `author_staff_id`.',
  })
  author_user_id!: string | null;

  @ApiProperty({
    example: null,
    nullable: true,
    description:
      'Author staff_member id when the message is from a staff member. XOR with `author_user_id`.',
  })
  author_staff_id!: string | null;

  @ApiProperty({
    example: 'Алия Серикова',
    nullable: true,
    description:
      'Display name of the message author — overlay resolved from whichever id is populated: `author_user_id` → `users.full_name`, else `author_staff_id` (`staff_members.id`) → `users.full_name` (staff identity fallback). Null when neither id is set, the underlying row is missing, or the resolved name is blank.',
  })
  author_full_name!: string | null;

  @ApiProperty({ example: 'Спасибо, можно ли подтвердить?' })
  body!: string;

  @ApiProperty({
    example: ['https://cdn.example.com/files/1.pdf'],
    nullable: true,
    isArray: true,
    type: 'string',
  })
  attachments!: string[] | null;

  @ApiProperty({ example: '2026-05-01T09:05:00.000Z' })
  created_at!: string;
}

export class ParentRequestMessageListResponseDto {
  @ApiProperty({ type: [ParentRequestMessageResponseDto] })
  items!: ParentRequestMessageResponseDto[];

  @ApiProperty({
    example: null,
    nullable: true,
    description: 'Cursor — pass back as `cursor` query. Null on last page.',
  })
  next_cursor!: string | null;
}
