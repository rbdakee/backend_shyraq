import { VideoCodec } from './domain/value-objects/video-codec.vo';

export interface StreamProbeResult {
  /**
   * False when the gateway does not know this stream key at all, or knows it
   * but could not reach the camera behind it. Callers must treat `false` as
   * "no information", never as "camera is gone" — a kindergarten's uplink
   * flapping for a minute should not wipe a good codec off the row.
   */
  available: boolean;
  videoCodec: VideoCodec;
}

/**
 * MediaGatewayPort — the media server that republishes camera RTSP to the
 * apps. Today that is a cloud go2rtc instance reached over WireGuard; the
 * port exists so the service layer never learns which one.
 *
 * Deliberately narrow: the gateway is asked what it has and what codec is on
 * the wire, nothing else. Access control, tokens and public URLs are ours and
 * live in the backend — the gateway has no notion of tenants or parents.
 */
export abstract class MediaGatewayPort {
  /** Probe one stream for liveness + codec. Never throws on a dead camera. */
  abstract probe(streamKey: string): Promise<StreamProbeResult>;

  /** Every stream key the gateway is configured with. Used by admin tooling. */
  abstract listStreamKeys(): Promise<string[]>;

  /**
   * Internal URL of the HLS master playlist for a stream. Internal because it
   * carries no access token and points at the gateway's private address — the
   * parent-facing URL is built on top of this by the streaming proxy.
   */
  abstract playlistUrl(streamKey: string): string;

  /**
   * Fetch the master playlist body. Opening it also opens a gateway session
   * whose id the body carries; that session is what the media playlist and
   * the segments are addressed by. Null when the gateway or the camera did
   * not answer.
   */
  abstract masterPlaylist(streamKey: string): Promise<string | null>;

  /** Fetch the media playlist of an already-opened gateway session. */
  abstract mediaPlaylist(sessionId: string): Promise<string | null>;
}
