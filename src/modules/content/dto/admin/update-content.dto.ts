import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO8601,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { normalizeLegacyKzLocale } from '../../../../shared-kernel/utils/i18n-locale-normalizer';

/**
 * Partial patch DTO for `PATCH /admin/content/:id`.
 *
 * `content_type` is intentionally omitted — it is immutable post-creation.
 * The service will throw `content_type_immutable` if it is ever injected.
 */
export class UpdateContentDto {
  @ApiProperty({
    example: 'all',
    description:
      'Targeting mode. Must be consistent with target_group_id / target_child_id.',
    enum: ['all', 'group', 'child'],
    required: false,
  })
  @IsOptional()
  @IsIn(['all', 'group', 'child'])
  target_type?: string;

  @ApiProperty({
    example: '550e8400-e29b-41d4-a716-446655440000',
    description: 'Required when target_type=group.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateContentDto) => o.target_type === 'group')
  @IsUUID()
  target_group_id?: string | null;

  @ApiProperty({
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    description: 'Required when target_type=child.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((o: UpdateContentDto) => o.target_type === 'child')
  @IsUUID()
  target_child_id?: string | null;

  @ApiProperty({
    example: 'Обновлённое объявление',
    description: 'Legacy single-locale title.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string | null;

  @ApiProperty({
    example: 'Текст объявления изменён.',
    description: 'Legacy single-locale body.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  body?: string | null;

  @ApiProperty({
    example: { ru: 'Обновлённое объявление', kk: 'Жаңартылған хабарландыру' },
    description: 'Localised title map.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @IsObject()
  title_i18n?: Record<string, string> | null;

  @ApiProperty({
    example: { ru: 'Текст изменён.', kk: 'Мәтін өзгерді.' },
    description: 'Localised body map.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @Transform(({ value }) => normalizeLegacyKzLocale(value))
  @IsObject()
  body_i18n?: Record<string, string> | null;

  @ApiProperty({
    example: { month: '2026-05', theme: 'Kindness' },
    description: 'Metadata JSONB patch.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown> | null;

  @ApiProperty({
    example: '2026-05-10T07:00:00.000Z',
    description:
      'Reschedule date. Only valid when post is in scheduled status. Must be in the future.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  scheduled_for?: string | null;

  @ApiProperty({
    example: '2026-05-17T23:59:59.000Z',
    description: 'Post expiry override.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  expires_at?: string | null;
}
