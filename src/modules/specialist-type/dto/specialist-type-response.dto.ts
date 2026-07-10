import { ApiProperty } from '@nestjs/swagger';

export class SpecialistTypeResponseDto {
  @ApiProperty({ example: '9f2c8a1b-3d4e-4f5a-8b6c-7d8e9f0a1b2c' })
  id!: string;

  @ApiProperty({
    example: 'doctor_nutritionist',
    description:
      'Machine code (immutable). Referenced by staff_members.specialist_type and diagnostic_templates.specialist_type.',
  })
  code!: string;

  @ApiProperty({
    example: { ru: 'Врач Нутрициолог', kk: 'Нутрициолог дәрігер' },
    description:
      'Localised display labels. At least one of ru/kk is present; extra locales allowed.',
    type: Object,
  })
  name_i18n!: Record<string, string>;

  @ApiProperty({
    example: true,
    description: 'System (seeded) rows cannot be deleted, only deactivated.',
  })
  is_system!: boolean;

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({ example: 5, description: 'Ascending display order.' })
  sort_order!: number;

  @ApiProperty({ example: '2026-07-10T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-07-10T10:00:00.000Z' })
  updated_at!: string;
}
