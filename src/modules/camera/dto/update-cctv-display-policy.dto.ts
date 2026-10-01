import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/** `HH:MM`, 24h, zero-padded — what an `<input type="time">` posts. */
const WALL_CLOCK_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** No kindergarten shows parents more common cameras than this. */
const MAX_COMMON_CAMERAS = 50;
const MAX_HIDE_RULES = 20;

export class UpdateCctvHideRuleDto {
  @ApiProperty({ example: 'Обед', description: 'Admin label. May be empty.' })
  @IsString()
  @MaxLength(60)
  name!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({
    type: [Number],
    example: [1, 2, 3, 4, 5, 6, 7],
    description:
      'ISO weekdays the window starts on: 1=Mon … 7=Sun. A past-midnight window started on Friday also covers early Saturday.',
  })
  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  days!: number[];

  @ApiProperty({ example: '12:30', description: 'Kindergarten-local `HH:MM`.' })
  @Matches(WALL_CLOCK_PATTERN)
  from!: string;

  @ApiProperty({
    example: '15:00',
    description:
      'Kindergarten-local `HH:MM`. Earlier than `from` means the window runs past midnight (19:00–08:00). Equal to `from` is refused (400 `cctv_policy_window_invalid`).',
  })
  @Matches(WALL_CLOCK_PATTERN)
  to!: string;

  @ApiProperty({
    example: false,
    description: 'Hide every common camera; `camera_ids` is then ignored.',
  })
  @IsBoolean()
  all_cameras!: boolean;

  @ApiProperty({
    type: [String],
    example: ['c1d2e3f4-3456-7890-cdef-3456789012cd'],
    description:
      'Common cameras to hide. Each must also be in `common_camera_ids` (400 `cctv_policy_rule_camera_not_common`).',
  })
  @IsArray()
  @ArrayMaxSize(MAX_COMMON_CAMERAS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  camera_ids!: string[];
}

export class UpdateCctvDisplayPolicyDto {
  @ApiProperty({
    type: [String],
    example: ['c1d2e3f4-3456-7890-cdef-3456789012cd'],
    description:
      'Cameras every parent sees on top of their own group camera, in display order. Every id must be a live camera of this kindergarten (404 `not_found`, 422 `camera_archived`).',
  })
  @IsArray()
  @ArrayMaxSize(MAX_COMMON_CAMERAS)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  common_camera_ids!: string[];

  @ApiProperty({ type: [UpdateCctvHideRuleDto] })
  @IsArray()
  @ArrayMaxSize(MAX_HIDE_RULES)
  @ValidateNested({ each: true })
  @Type(() => UpdateCctvHideRuleDto)
  hide_rules!: UpdateCctvHideRuleDto[];
}
