import { ApiProperty } from '@nestjs/swagger';
import {
  CCTV_DISPLAY_MODES,
  CctvDisplayMode,
} from '../domain/value-objects/cctv-display-mode.vo';

export class CctvDisplaySlotDto {
  @ApiProperty({
    example: 'schedule',
    enum: CCTV_DISPLAY_MODES,
    description:
      '`schedule` — follow the child`s group (scheduled room, else the group`s location), with `camera_ids` as the fallback when that leads nowhere. `cameras` — show exactly `camera_ids` to every parent. `off` — show nothing.',
  })
  mode!: CctvDisplayMode;

  @ApiProperty({
    type: [String],
    example: ['c1d2e3f4-3456-7890-cdef-3456789012cd'],
    description:
      'Cameras for this slot, in display order. Meaningless when mode is `off`.',
  })
  camera_ids!: string[];
}

export class CctvDisplayPolicyDto {
  @ApiProperty({
    type: [Number],
    example: [1, 2, 3, 4, 5],
    description: 'ISO weekdays the kindergarten works: 1=Mon … 7=Sun.',
  })
  work_days!: number[];

  @ApiProperty({
    example: '07:00',
    description: 'Opening wall clock, kindergarten-local (see `timezone`).',
  })
  opens_at!: string;

  @ApiProperty({ example: '19:00', description: 'Closing wall clock.' })
  closes_at!: string;

  @ApiProperty({
    example: 'Asia/Almaty',
    description:
      'Zone the window above is read in. Informational — the server owns the decision; this is here so the admin UI can label the times.',
  })
  timezone!: string;

  @ApiProperty({
    type: CctvDisplaySlotDto,
    description: 'What parents see on a working day inside the window.',
  })
  work_hours!: CctvDisplaySlotDto;

  @ApiProperty({
    type: CctvDisplaySlotDto,
    description:
      'What parents see the rest of the time — evenings, weekends, non-working days.',
  })
  off_hours!: CctvDisplaySlotDto;

  @ApiProperty({
    example: '2026-09-21T09:15:00.000Z',
    description:
      'When the policy was last saved. Equals `now` for a kindergarten that has never saved one and is therefore running on the defaults.',
  })
  updated_at!: string;
}
