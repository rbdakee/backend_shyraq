import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

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
}
