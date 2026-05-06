import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export type OpenRequestRecipientType = 'admin' | 'mentor' | 'specialist';

const RECIPIENT_TYPES: readonly OpenRequestRecipientType[] = [
  'admin',
  'mentor',
  'specialist',
];

/**
 * Body shape for `POST /parent/requests/open`. Free-form question/message
 * directed at the kindergarten admin, the child's mentor, or a named specialist
 * (psychologist/speech-therapist/etc).
 *
 * `recipient_staff_id` semantics:
 *   - `admin` recipient_type → ignored (server resolves to "any admin in kg")
 *   - `mentor` recipient_type → optional; when omitted the server resolves
 *     the child's currently active group mentor; when present validates the
 *     staff_member is a mentor in this kg
 *   - `specialist` recipient_type → REQUIRED; the parent must pick a named
 *     specialist (the UI shows the kg's specialists list)
 */
export class CreateOpenRequestDto {
  @ApiProperty({ example: 'cccccccc-cccc-cccc-cccc-cccccccccccc' })
  @IsUUID()
  child_id!: string;

  @ApiProperty({
    example: 'specialist',
    enum: RECIPIENT_TYPES,
  })
  @IsEnum(RECIPIENT_TYPES)
  recipient_type!: OpenRequestRecipientType;

  @ApiProperty({
    example: 'bbbbbbbb-2222-3333-4444-bbbbbbbbbbbb',
    nullable: true,
    required: false,
    description:
      'Required when recipient_type=specialist. Optional for mentor (defaults to child group mentor).',
  })
  @IsOptional()
  @IsUUID()
  recipient_staff_id?: string | null;

  @ApiProperty({
    example: 'Вопрос по адаптации',
    minLength: 2,
    maxLength: 200,
  })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  subject!: string;

  @ApiProperty({
    example: 'Здравствуйте! Хотел бы обсудить адаптацию ребёнка...',
    minLength: 1,
    maxLength: 4000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  message!: string;

  @ApiProperty({
    example: ['https://cdn.example.com/files/note.pdf'],
    isArray: true,
    type: 'string',
    nullable: true,
    required: false,
    maxItems: 10,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  attachments?: string[] | null;
}
