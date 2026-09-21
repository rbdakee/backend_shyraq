import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CCTV_DISPLAY_MODES,
  CctvDisplayMode,
} from '../domain/value-objects/cctv-display-mode.vo';

/** `HH:MM`, 24h, zero-padded — what an `<input type="time">` posts. */
const WALL_CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** No kindergarten points parents at more cameras than this in one slot. */
const MAX_SLOT_CAMERAS = 50;

export class UpdateCctvDisplaySlotDto {
  @ApiProperty({ example: 'cameras', enum: CCTV_DISPLAY_MODES })
  @IsIn(CCTV_DISPLAY_MODES)
  mode!: CctvDisplayMode;

  @ApiProperty({
    type: [String],
    example: ['c1d2e3f4-3456-7890-cdef-3456789012cd'],
    description:
      'Cameras for this slot, in display order. Send `[]` for `off`, or for `schedule` with no fallback. Every id must be a live camera of this kindergarten (404 `camera_not_found`, 409 `camera_archived`).',
  })
  @IsArray()
  @ArrayMaxSize(MAX_SLOT_CAMERAS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  camera_ids!: string[];
}

export class UpdateCctvDisplayPolicyDto {
  @ApiProperty({
    type: [Number],
    example: [1, 2, 3, 4, 5],
    description:
      'ISO weekdays the kindergarten works: 1=Mon … 7=Sun. `[]` makes every day an off-hours day.',
  })
  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  work_days!: number[];

  @ApiProperty({
    example: '07:00',
    description: 'Opening wall clock in kindergarten-local time, `HH:MM`.',
  })
  @Matches(WALL_CLOCK_PATTERN)
  opens_at!: string;

  @ApiProperty({
    example: '19:00',
    description: 'Closing wall clock. Must be later than `opens_at`.',
  })
  @Matches(WALL_CLOCK_PATTERN)
  closes_at!: string;

  @ApiProperty({ type: UpdateCctvDisplaySlotDto })
  @ValidateNested()
  @Type(() => UpdateCctvDisplaySlotDto)
  work_hours!: UpdateCctvDisplaySlotDto;

  @ApiProperty({ type: UpdateCctvDisplaySlotDto })
  @ValidateNested()
  @Type(() => UpdateCctvDisplaySlotDto)
  off_hours!: UpdateCctvDisplaySlotDto;
}
