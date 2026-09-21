import { ApiProperty } from '@nestjs/swagger';
import {
  CCTV_DISPLAY_MODES,
  CctvDisplayMode,
} from '../domain/value-objects/cctv-display-mode.vo';
import {
  StreamTransport,
  VideoCodec,
} from '../domain/value-objects/video-codec.vo';

export class CctvStreamDto {
  @ApiProperty({
    example: 'hls',
    enum: ['hls', 'webrtc'],
    description:
      'How to play this URL. Take the FIRST entry your player supports and do not branch on the codec yourself — when a camera is switched to H.264 a webrtc entry appears here on its own.',
  })
  transport!: StreamTransport;

  @ApiProperty({
    example:
      'https://balam-stream.innodev.kz/hls/c1d2e3f4-3456-7890-cdef-3456789012cd/index.m3u8?t=v1.c1d2e3f4...',
    description:
      'Playable URL, already carrying the access token. Treat it as opaque and short-lived.',
  })
  url!: string;
}

export class CctvCameraDto {
  @ApiProperty({ example: 'c1d2e3f4-3456-7890-cdef-3456789012cd' })
  camera_id!: string;

  @ApiProperty({ example: 'Ashana' })
  name!: string;

  @ApiProperty({ example: 'a1b2c3d4-1234-5678-abcd-1234567890ab' })
  location_id!: string;

  @ApiProperty({ example: 'Столовая', nullable: true })
  location_name!: string | null;

  @ApiProperty({
    example: 'h265',
    nullable: true,
    enum: ['h264', 'h265', 'unknown'],
    description:
      'Informational — for showing the operator why a camera may not play on a given device. Playback decisions belong to `streams`.',
  })
  video_codec!: VideoCodec | null;

  @ApiProperty({ type: [CctvStreamDto] })
  streams!: CctvStreamDto[];
}

export class CctvAccessDto {
  @ApiProperty({
    type: [CctvCameraDto],
    description:
      'Cameras the parent may watch RIGHT NOW, picked by the kindergarten`s display policy — usually the location the child`s group is in at this moment, or a fixed set the kindergarten pins for everyone. Empty is a normal answer: viewing may be closed for the hour, or the group has no location, no camera there, or no camera bound to the media gateway. `display_mode` says which of those it was.',
  })
  cameras!: CctvCameraDto[];

  @ApiProperty({
    example: '2026-09-14T13:00:00.000Z',
    nullable: true,
    description:
      'When the URLs above stop working. Null when the list is empty. Re-request this endpoint before it passes, and also whenever the group`s location-changed event arrives.',
  })
  expires_at!: string | null;

  @ApiProperty({
    example: 'schedule',
    enum: CCTV_DISPLAY_MODES,
    description:
      'Which rule produced this list, per the kindergarten`s display policy: `schedule` — the room the child`s group is in now (or the fallback cameras); `cameras` — a fixed set the kindergarten shows every parent; `off` — viewing is closed right now, so an empty list is the intended answer and not a failure. Use it to word the empty state; do not branch playback on it.',
  })
  display_mode!: CctvDisplayMode;
}
