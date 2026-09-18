import { Injectable, Logger } from '@nestjs/common';
import { Go2rtcConfig } from '../../config/cctv-config.type';
import { VideoCodec } from '../../domain/value-objects/video-codec.vo';
import { MediaGatewayPort, StreamProbeResult } from '../../media-gateway.port';

export type Go2rtcFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

interface Go2rtcProducer {
  medias?: string[];
  sdp?: string;
}

interface Go2rtcStreamInfo {
  producers?: Go2rtcProducer[] | null;
}

const UNAVAILABLE: StreamProbeResult = {
  available: false,
  videoCodec: 'unknown',
};

/**
 * go2rtc adapter for MediaGatewayPort.
 *
 * Probing: `GET /api/streams?src=<key>&video=all&audio=all` makes go2rtc dial
 * the camera and report what it got. The answer carries both a parsed
 * `medias: ["video, recvonly, H265"]` list and the raw SDP; we read the former
 * and fall back to `a=rtpmap:<pt> H26x/90000` in the latter, because the
 * medias formatting is a go2rtc presentation detail while the SDP line is the
 * wire format. An unknown key answers 404.
 *
 * Probing is not free — it opens a real RTSP session over the kindergarten's
 * uplink for a moment — so only the periodic probe job and explicit admin
 * refreshes call it. Never per parent request.
 */
@Injectable()
export class Go2rtcMediaGatewayAdapter extends MediaGatewayPort {
  private readonly logger = new Logger(Go2rtcMediaGatewayAdapter.name);
  private readonly fetchImpl: Go2rtcFetch;

  constructor(
    private readonly config: Go2rtcConfig,
    fetchImpl?: Go2rtcFetch,
  ) {
    super();
    this.fetchImpl =
      fetchImpl ??
      ((input, init) => globalThis.fetch(input as RequestInfo, init));
  }

  async probe(streamKey: string): Promise<StreamProbeResult> {
    const url = `${this.config.baseUrl}/api/streams?src=${encodeURIComponent(
      streamKey,
    )}&video=all&audio=all`;

    const response = await this.request(url);
    if (!response || !response.ok) {
      return UNAVAILABLE;
    }

    let info: Go2rtcStreamInfo;
    try {
      info = (await response.json()) as Go2rtcStreamInfo;
    } catch {
      return UNAVAILABLE;
    }

    const producers = info.producers ?? [];
    if (producers.length === 0) {
      return UNAVAILABLE;
    }

    for (const producer of producers) {
      const codec =
        codecFromMedias(producer.medias) ?? codecFromSdp(producer.sdp);
      if (codec) {
        return { available: true, videoCodec: codec };
      }
    }

    // Gateway answered and a producer is connected, but no video track was
    // recognised — audio-only or a codec we do not model. Available, codec
    // unknown: HLS is still offered, WebRTC is not.
    return { available: true, videoCodec: 'unknown' };
  }

  async listStreamKeys(): Promise<string[]> {
    const response = await this.request(`${this.config.baseUrl}/api/streams`);
    if (!response || !response.ok) {
      return [];
    }
    try {
      const body = (await response.json()) as Record<string, unknown>;
      return Object.keys(body ?? {});
    } catch {
      return [];
    }
  }

  /**
   * `&mp4` is load-bearing, not decoration. Without it go2rtc packs the video
   * into MPEG-TS segments, and HEVC-in-TS plays in no player we ship to —
   * iOS refuses it and hls.js refuses it, both silently (black frame, no
   * error). With it the playlist is HLS v6 fMP4 (`#EXT-X-MAP` + `.m4s`),
   * which is the only HEVC-over-HLS packaging Apple ever supported and which
   * H.264 also rides fine. Do not drop the parameter to "simplify" the URL.
   */
  playlistUrl(streamKey: string): string {
    return `${this.config.baseUrl}/api/stream.m3u8?src=${encodeURIComponent(
      streamKey,
    )}&mp4`;
  }

  async masterPlaylist(streamKey: string): Promise<string | null> {
    return this.text(this.playlistUrl(streamKey));
  }

  async mediaPlaylist(sessionId: string): Promise<string | null> {
    return this.text(
      `${this.config.baseUrl}/api/hls/playlist.m3u8?id=${encodeURIComponent(
        sessionId,
      )}`,
    );
  }

  private async text(url: string): Promise<string | null> {
    const response = await this.request(url);
    if (!response || !response.ok) return null;
    try {
      return await response.text();
    } catch {
      return null;
    }
  }

  private async request(url: string): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: this.basicAuth() },
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`go2rtc GET ${url} failed: ${reason}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private basicAuth(): string {
    const raw = `${this.config.username}:${this.config.password}`;
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }
}

function codecFromMedias(medias?: string[]): VideoCodec | null {
  for (const media of medias ?? []) {
    if (!/(^|,)\s*video\b/i.test(media)) continue;
    const codec = matchCodec(media);
    if (codec) return codec;
  }
  return null;
}

function codecFromSdp(sdp?: string): VideoCodec | null {
  if (!sdp) return null;
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=rtpmap:')) continue;
    const codec = matchCodec(line);
    if (codec) return codec;
  }
  return null;
}

function matchCodec(text: string): VideoCodec | null {
  if (/\bH\.?265\b/i.test(text) || /\bHEVC\b/i.test(text)) return 'h265';
  if (/\bH\.?264\b/i.test(text) || /\bAVC\b/i.test(text)) return 'h264';
  return null;
}
