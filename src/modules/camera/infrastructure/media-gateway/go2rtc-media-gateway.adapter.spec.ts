import { Go2rtcConfig } from '../../config/cctv-config.type';
import {
  Go2rtcFetch,
  Go2rtcMediaGatewayAdapter,
} from './go2rtc-media-gateway.adapter';

const CONFIG: Go2rtcConfig = {
  baseUrl: 'http://127.0.0.1:1984',
  username: 'admin',
  password: 'secret',
  timeoutMs: 1000,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function adapterWith(fetchImpl: Go2rtcFetch): Go2rtcMediaGatewayAdapter {
  return new Go2rtcMediaGatewayAdapter(CONFIG, fetchImpl);
}

describe('Go2rtcMediaGatewayAdapter.probe', () => {
  it('returns h265 from the medias summary go2rtc reports', async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(
        jsonResponse({
          producers: [{ medias: ['video, recvonly, H265'] }],
          consumers: [],
        }),
      ),
    );

    await expect(adapter.probe('cam02_sub')).resolves.toEqual({
      available: true,
      videoCodec: 'h265',
    });
  });

  it('returns h264 once the camera is switched over', async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(
        jsonResponse({ producers: [{ medias: ['video, recvonly, H264'] }] }),
      ),
    );

    await expect(adapter.probe('cam02_sub')).resolves.toEqual({
      available: true,
      videoCodec: 'h264',
    });
  });

  it('falls back to the SDP rtpmap line when medias is absent', async () => {
    const sdp = [
      'v=0',
      'm=video 0 RTP/AVP 98',
      'a=rtpmap:98 H265/90000',
      'a=control:trackID=0',
    ].join('\r\n');
    const adapter = adapterWith(() =>
      Promise.resolve(jsonResponse({ producers: [{ sdp }] })),
    );

    await expect(adapter.probe('cam02_sub')).resolves.toEqual({
      available: true,
      videoCodec: 'h265',
    });
  });

  it('ignores an audio-only media entry when picking the video codec', async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(
        jsonResponse({
          producers: [
            { medias: ['audio, recvonly, PCMA', 'video, recvonly, H264'] },
          ],
        }),
      ),
    );

    await expect(adapter.probe('cam02_sub')).resolves.toEqual({
      available: true,
      videoCodec: 'h264',
    });
  });

  it('reports unavailable for a stream key the gateway does not know (404)', async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(new Response('not found', { status: 404 })),
    );

    await expect(adapter.probe('nosuchcam')).resolves.toEqual({
      available: false,
      videoCodec: 'unknown',
    });
  });

  it('reports unavailable when the camera is configured but not answering', async () => {
    const adapter = adapterWith(() =>
      Promise.resolve(jsonResponse({ producers: null, consumers: [] })),
    );

    await expect(adapter.probe('cam16_sub')).resolves.toEqual({
      available: false,
      videoCodec: 'unknown',
    });
  });

  it('reports unavailable instead of throwing when the gateway is unreachable', async () => {
    const adapter = adapterWith(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    );

    await expect(adapter.probe('cam02_sub')).resolves.toEqual({
      available: false,
      videoCodec: 'unknown',
    });
  });

  it('sends basic auth and asks for both media kinds', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const adapter = adapterWith((url, init) => {
      calls.push({ url, init });
      return Promise.resolve(jsonResponse({ producers: [] }));
    });

    await adapter.probe('cam02_sub');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      'http://127.0.0.1:1984/api/streams?src=cam02_sub&video=all&audio=all',
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from('admin:secret').toString('base64')}`,
    );
  });
});

describe('Go2rtcMediaGatewayAdapter.playlistUrl', () => {
  // Without `&mp4` go2rtc emits HEVC inside MPEG-TS, which no player we ship
  // to can decode — and it fails silently. Guarding it in a test because the
  // parameter looks removable and is not.
  it('requests fMP4 packaging so HEVC is playable', () => {
    expect(
      adapterWith(() => Promise.reject(new Error())).playlistUrl('cam02_sub'),
    ).toBe('http://127.0.0.1:1984/api/stream.m3u8?src=cam02_sub&mp4');
  });
});
