import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { STREAM_KEY_PATTERN } from './stream-key.constants';

export class CreateCameraDto {
  @ApiProperty({
    example: 'a1b2c3d4-1234-5678-abcd-1234567890ab',
    format: 'uuid',
  })
  @IsUUID()
  location_id!: string;

  @ApiProperty({ example: 'Entrance Camera', minLength: 1, maxLength: 255 })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({
    example: 'rtsp://192.168.1.50:554/stream1',
    description:
      'RTSP stream URL. Optional — a placeholder is used until the MediaMTX integration sets the real URL.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rtsp_url?: string;

  @ApiPropertyOptional({
    example: 'https://hls.shyraq.test/cam1/index.m3u8',
    description: 'HLS playback URL (optional, may be null).',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  hls_url?: string;

  @ApiPropertyOptional({
    example: 'cam02_sub',
    description:
      'Media-gateway stream key of the low-res sub-stream — what parents watch. Must match the stream name in the gateway config, and is unique across all kindergartens (409 camera_stream_key_taken otherwise).',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(STREAM_KEY_PATTERN)
  stream_key?: string;

  @ApiPropertyOptional({
    example: 'cam02_main',
    description:
      'Optional full-resolution stream key for single-camera view. Same uniqueness rule.',
    maxLength: 128,
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(STREAM_KEY_PATTERN)
  stream_key_hd?: string;
}
