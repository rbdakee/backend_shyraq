import { Camera, CameraState } from './camera.entity';

const NOW = new Date('2026-09-14T10:00:00.000Z');
const LATER = new Date('2026-09-14T11:00:00.000Z');

function makeCamera(overrides: Partial<CameraState> = {}): Camera {
  return Camera.hydrate({
    id: 'cam-1',
    kindergartenId: 'kg-1',
    locationId: 'loc-1',
    name: 'Ashana',
    rtspUrl: 'rtsp://192.168.1.4:554/cam/realmonitor?channel=1&subtype=1',
    hlsUrl: null,
    streamKey: 'cam04_sub',
    streamKeyHd: 'cam04_main',
    videoCodec: 'h265',
    codecCheckedAt: NOW,
    isActive: true,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('Camera codec and transports', () => {
  it('returns HLS only for an H.265 camera', () => {
    expect(makeCamera({ videoCodec: 'h265' }).availableTransports).toEqual([
      'hls',
    ]);
  });

  it('returns WebRTC ahead of HLS once the camera emits H.264', () => {
    expect(makeCamera({ videoCodec: 'h264' }).availableTransports).toEqual([
      'webrtc',
      'hls',
    ]);
  });

  it('returns HLS for a camera that has never been probed', () => {
    const cam = makeCamera({ videoCodec: null, codecCheckedAt: null });
    expect(cam.effectiveCodec).toBe('unknown');
    expect(cam.availableTransports).toEqual(['hls']);
  });

  it('returns no transports for a camera with no stream key', () => {
    const cam = makeCamera({ streamKey: null, streamKeyHd: null });
    expect(cam.isStreamable).toBe(false);
    expect(cam.availableTransports).toEqual([]);
  });

  it('returns no transports for an archived camera', () => {
    const cam = makeCamera();
    cam.archive(LATER);
    expect(cam.isStreamable).toBe(false);
    expect(cam.availableTransports).toEqual([]);
  });

  it('records a probed codec together with the check timestamp', () => {
    const cam = makeCamera({ videoCodec: null, codecCheckedAt: null });
    cam.recordCodecProbe('h264', LATER);
    expect(cam.videoCodec).toBe('h264');
    expect(cam.codecCheckedAt).toEqual(LATER);
    expect(cam.availableTransports).toEqual(['webrtc', 'hls']);
  });

  it('forgets the probed codec when the stream key changes', () => {
    const cam = makeCamera();
    cam.setStreamKeys({ streamKey: 'cam09_sub' }, LATER);
    expect(cam.streamKey).toBe('cam09_sub');
    expect(cam.videoCodec).toBeNull();
    expect(cam.codecCheckedAt).toBeNull();
  });

  it('keeps the probed codec when the stream key is re-set to the same value', () => {
    const cam = makeCamera();
    cam.setStreamKeys({ streamKey: 'cam04_sub' }, LATER);
    expect(cam.videoCodec).toBe('h265');
    expect(cam.codecCheckedAt).toEqual(NOW);
    expect(cam.updatedAt).toEqual(NOW);
  });

  it('unbinds a camera from the gateway when the stream key is cleared', () => {
    const cam = makeCamera();
    cam.setStreamKeys({ streamKey: null }, LATER);
    expect(cam.isStreamable).toBe(false);
    expect(cam.availableTransports).toEqual([]);
  });
});
