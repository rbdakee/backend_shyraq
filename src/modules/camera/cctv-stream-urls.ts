import { Camera } from './domain/entities/camera.entity';
import { StreamTransport } from './domain/value-objects/video-codec.vo';

/**
 * Transports the backend can actually serve today.
 *
 * A camera may *support* WebRTC — that is what `Camera.availableTransports`
 * reports once it emits H.264 — but advertising a URL we cannot serve would
 * hand the client a dead link. So what we offer is the intersection of what
 * the camera supports and what is wired up. When the WebRTC path is built,
 * add `'webrtc'` here and every H.264 camera starts offering it; nothing else
 * changes, in this codebase or in the apps.
 */
export const SERVABLE_TRANSPORTS: ReadonlySet<StreamTransport> = new Set([
  'hls',
]);

export interface CctvStreamVariant {
  transport: StreamTransport;
  url: string;
}

/**
 * Playable URLs for one camera. Shared by the parent and admin paths so the
 * two cannot drift into offering different transports for the same camera.
 */
export function buildStreamVariants(
  camera: Camera,
  token: string,
  publicBase: string | null,
): CctvStreamVariant[] {
  if (!publicBase) return [];
  return camera.availableTransports
    .filter((transport) => SERVABLE_TRANSPORTS.has(transport))
    .map((transport) => ({
      transport,
      url: `${publicBase}/hls/${camera.id}/index.m3u8?t=${encodeURIComponent(token)}`,
    }));
}
