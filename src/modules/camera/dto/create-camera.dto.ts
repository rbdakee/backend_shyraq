import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

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
}
