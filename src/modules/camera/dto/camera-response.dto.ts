import { ApiProperty } from '@nestjs/swagger';
import {
  StreamTransport,
  VideoCodec,
} from '../domain/value-objects/video-codec.vo';

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

  @ApiProperty({
    example: 'cam02_sub',
    nullable: true,
    description:
      'Media-gateway stream key of the sub-stream. Null until the camera is bound to the gateway.',
  })
  stream_key!: string | null;

  @ApiProperty({
    example: 'cam02_main',
    nullable: true,
    description: 'Full-resolution stream key, when one is configured.',
  })
  stream_key_hd!: string | null;

  @ApiProperty({
    example: 'h265',
    nullable: true,
    enum: ['h264', 'h265', 'unknown'],
    description:
      'Codec last observed on the wire. Filled in automatically by the codec probe — never sent by clients. Null means the camera has not been probed yet.',
  })
  video_codec!: VideoCodec | null;

  @ApiProperty({
    example: '2026-09-14T08:30:00.000Z',
    nullable: true,
    description:
      'When the codec was last confirmed. A timestamp far in the past means the gateway has not been able to reach the camera since.',
  })
  codec_checked_at!: string | null;

  @ApiProperty({
    example: true,
    description:
      'Whether this camera can currently be watched at all (active, not archived, bound to a stream key).',
  })
  is_streamable!: boolean;

  @ApiProperty({
    example: ['hls'],
    isArray: true,
    enum: ['hls', 'webrtc'],
    description:
      'Transports the camera can be watched over, most-preferred first. H.265 cameras offer HLS only; a camera switched to H.264 gains WebRTC here automatically, with no client change.',
  })
  transports!: StreamTransport[];

  @ApiProperty({ example: true })
  is_active!: boolean;

  @ApiProperty({ example: null, nullable: true })
  archived_at!: string | null;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  created_at!: string;

  @ApiProperty({ example: '2026-04-24T10:00:00.000Z' })
  updated_at!: string;
}
