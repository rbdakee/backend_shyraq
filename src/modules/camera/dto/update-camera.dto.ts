import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { STREAM_KEY_PATTERN } from './stream-key.constants';

export class UpdateCameraDto {
  @ApiPropertyOptional({
    example: 'a1b2c3d4-1234-5678-abcd-1234567890ab',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  location_id?: string;

  @ApiPropertyOptional({ example: 'Side Entrance Camera', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    example: 'rtsp://192.168.1.51:554/stream2',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rtsp_url?: string;

  @ApiPropertyOptional({
    example: 'https://hls.shyraq.test/cam1/index.m3u8',
    description: 'Send null to clear.',
    nullable: true,
    maxLength: 1000,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  hls_url?: string | null;

  @ApiPropertyOptional({
    example: 'cam02_sub',
    description:
      'Media-gateway stream key (sub-stream). Send null to unbind the camera from the gateway. Changing it resets the probed codec — the next probe re-establishes it.',
    nullable: true,
    maxLength: 128,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(128)
  @Matches(STREAM_KEY_PATTERN)
  stream_key?: string | null;

  @ApiPropertyOptional({
    example: 'cam02_main',
    description: 'Full-resolution stream key. Send null to clear.',
    nullable: true,
    maxLength: 128,
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(128)
  @Matches(STREAM_KEY_PATTERN)
  stream_key_hd?: string | null;
}
