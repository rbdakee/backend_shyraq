import { Injectable, Logger } from '@nestjs/common';
import { VideoCodec } from '../../domain/value-objects/video-codec.vo';
import { MediaGatewayPort, StreamProbeResult } from '../../media-gateway.port';

/**
 * Mock gateway for local dev and tests — the default, so a developer with no
 * tunnel to a kindergarten still gets a working CCTV module.
 *
 * Reports every stream as live H.265, matching the cameras actually installed
 * today. `MOCK_CCTV_CODEC=h264` flips it, which is how the H.264 code path
 * gets exercised before a single camera is switched over.
 */
@Injectable()
export class MockMediaGatewayAdapter extends MediaGatewayPort {
  private readonly logger = new Logger(MockMediaGatewayAdapter.name);
  private readonly codec: VideoCodec;

  constructor(codec?: VideoCodec) {
    super();
    this.codec =
      codec ??
      (process.env.MOCK_CCTV_CODEC?.trim().toLowerCase() === 'h264'
        ? 'h264'
        : 'h265');
  }

  probe(streamKey: string): Promise<StreamProbeResult> {
    this.logger.debug(`mock probe ${streamKey} → ${this.codec}`);
    return Promise.resolve({ available: true, videoCodec: this.codec });
  }

  listStreamKeys(): Promise<string[]> {
    return Promise.resolve([]);
  }

  playlistUrl(streamKey: string): string {
    return `mock://media-gateway/${encodeURIComponent(streamKey)}.m3u8`;
  }

  masterPlaylist(streamKey: string): Promise<string | null> {
    const codec = this.codec === 'h264' ? 'avc1.640029' : 'hvc1.1.6.L153.B0';
    return Promise.resolve(
      [
        '#EXTM3U',
        `#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="${codec}"`,
        `hls/playlist.m3u8?id=mock-${streamKey}`,
        '',
      ].join('\n'),
    );
  }

  mediaPlaylist(sessionId: string): Promise<string | null> {
    return Promise.resolve(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:1',
        '#EXT-X-MEDIA-SEQUENCE:0',
        `#EXT-X-MAP:URI="init.mp4?id=${sessionId}"`,
        '#EXTINF:0.500,',
        `segment.m4s?id=${sessionId}&n=0`,
        '',
      ].join('\n'),
    );
  }
}
