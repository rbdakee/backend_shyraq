import { ApiProperty } from '@nestjs/swagger';

export class CameraDto {
  @ApiProperty({ example: 'c1d2e3f4-3456-7890-cdef-3456789012cd' })
  id!: string;

  @ApiProperty({ example: '7c2c2b6a-1a2b-4c3d-9e8f-0a1b2c3d4e5f' })
  kindergarten_id!: string;

  @ApiProperty({ example: 'a1b2c3d4-1234-5678-abcd-1234567890ab' })
  location_id!: string;

  @ApiProperty({ example: 'Entrance Camera' })
  name!: string;

  @ApiProperty({ example: 'rtsp://192.168.1.50:554/stream1' })
  rtsp_url!: string;

  @ApiProperty({ example: null, nullable: true })
  hls_url!: string | null;

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({ example: null, nullable: true })
  archived_at!: string | null;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  updated_at!: string;
}
