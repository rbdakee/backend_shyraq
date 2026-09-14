import { ApiProperty } from '@nestjs/swagger';
import { CctvStreamDto } from './parent-cctv-response.dto';
import { VideoCodec } from '../domain/value-objects/video-codec.vo';

export class CameraStreamAccessDto {
  @ApiProperty({ example: 'c1d2e3f4-3456-7890-cdef-3456789012cd' })
  camera_id!: string;

  @ApiProperty({ example: 'Столовая (Ashana)' })
  name!: string;

  @ApiProperty({
    example: 'h265',
    nullable: true,
    enum: ['h264', 'h265', 'unknown'],
    description:
      'Informational. Pick a player from `streams`, not from this field.',
  })
  video_codec!: VideoCodec | null;

  @ApiProperty({
    type: [CctvStreamDto],
    description:
      'Empty when the camera is archived, has no stream key, or streaming is not configured in this environment.',
  })
  streams!: CctvStreamDto[];

  @ApiProperty({
    example: '2026-09-14T13:00:00.000Z',
    nullable: true,
    description: 'When these URLs stop working. Null when `streams` is empty.',
  })
  expires_at!: string | null;
}
