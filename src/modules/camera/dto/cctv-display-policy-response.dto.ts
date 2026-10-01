import { ApiProperty } from '@nestjs/swagger';

export class CctvHideRuleDto {
  @ApiProperty({ example: 'Обед' })
  name!: string;

  @ApiProperty({ example: true })
  enabled!: boolean;

  @ApiProperty({
    type: [Number],
    example: [1, 2, 3, 4, 5, 6, 7],
    description: 'ISO weekdays the window starts on: 1=Mon … 7=Sun.',
  })
  days!: number[];

  @ApiProperty({ example: '12:30', description: 'Kindergarten-local `HH:MM`.' })
  from!: string;

  @ApiProperty({
    example: '15:00',
    description: 'Earlier than `from` — the window runs past midnight.',
  })
  to!: string;

  @ApiProperty({ example: false, description: 'Hides every common camera.' })
  all_cameras!: boolean;

  @ApiProperty({
    type: [String],
    example: ['c1d2e3f4-3456-7890-cdef-3456789012cd'],
    description: 'Common cameras the rule hides. Empty when `all_cameras`.',
  })
  camera_ids!: string[];
}

export class CctvDisplayPolicyDto {
  @ApiProperty({
    type: [String],
    example: ['c1d2e3f4-3456-7890-cdef-3456789012cd'],
    description:
      'Cameras every parent sees on top of their group camera, in display order. The group camera itself is always shown and is not part of the policy.',
  })
  common_camera_ids!: string[];

  @ApiProperty({
    type: [CctvHideRuleDto],
    description:
      'Time rules hiding common cameras. A kindergarten that never saved a policy gets a disabled night rule (19:00–08:00, all common cameras).',
  })
  hide_rules!: CctvHideRuleDto[];

  @ApiProperty({
    example: 'Asia/Almaty',
    description:
      'Zone the rule windows are read in. Informational — the server owns the decision; this is here so the admin UI can label the times.',
  })
  timezone!: string;

  @ApiProperty({
    example: '2026-09-21T09:15:00.000Z',
    description:
      'When the policy was last saved. Equals `now` for a kindergarten that has never saved one and is therefore running on the defaults.',
  })
  updated_at!: string;
}
