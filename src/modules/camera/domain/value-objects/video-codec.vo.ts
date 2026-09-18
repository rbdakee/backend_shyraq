/**
 * Video codec a camera currently emits, and the transports that codec can
 * actually be delivered over.
 *
 * This file is the ONE place in the codebase that knows the codec→transport
 * rule. Everything downstream (parent API, admin API, the apps) reads the
 * transport list rather than testing the codec itself, which is what makes the
 * H.265→H.264 switch a data change rather than a code change: the day a
 * kindergarten flips a camera, the probe job writes `h264` on the row and a
 * WebRTC variant appears in the API response on its own.
 */
export type VideoCodec = 'h264' | 'h265' | 'unknown';

export const VIDEO_CODECS: readonly VideoCodec[] = ['h264', 'h265', 'unknown'];

export function isVideoCodec(value: unknown): value is VideoCodec {
  return (
    typeof value === 'string' && VIDEO_CODECS.includes(value as VideoCodec)
  );
}

/**
 * Transport by which a player can consume a stream.
 *
 *   - `hls`    — fMP4 HLS off the media gateway. Plays H.264 everywhere and
 *                H.265 on iOS/Safari plus any Android/desktop with a hardware
 *                HEVC decoder. Latency ~2-4s. Our universal fallback.
 *   - `webrtc` — sub-second, but the browser/mobile WebRTC stacks do not
 *                decode H.265 in practice, so it is offered for H.264 only.
 */
export type StreamTransport = 'hls' | 'webrtc';

/**
 * Transports usable for a codec, most-preferred first.
 *
 * `unknown` (never probed, or the camera was unreachable when we last looked)
 * degrades to HLS: it plays whichever of the two codecs actually shows up, so
 * an un-probed camera is watchable rather than broken.
 */
export function transportsForCodec(codec: VideoCodec): StreamTransport[] {
  return codec === 'h264' ? ['webrtc', 'hls'] : ['hls'];
}
