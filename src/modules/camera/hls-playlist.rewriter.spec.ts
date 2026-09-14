import {
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
} from './hls-playlist.rewriter';

const OPTS = {
  publicBase: 'https://balam-stream.innodev.kz',
  token: 'v1.cam.user.123.sig',
};

// Bodies below are what go2rtc 1.9.14 actually returned for cam02_sub.
const MASTER = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="hvc1.1.6.L153.B0"',
  'hls/playlist.m3u8?id=QXW4ZzIf',
  '',
].join('\n');

const MEDIA = [
  '#EXTM3U',
  '#EXT-X-VERSION:6',
  '#EXT-X-TARGETDURATION:1',
  '#EXT-X-MEDIA-SEQUENCE:0',
  '#EXT-X-MAP:URI="init.mp4?id=yY254PQ0"',
  '#EXTINF:0.500,',
  'segment.m4s?id=yY254PQ0&n=0',
  '#EXTINF:0.500,',
  'segment.m4s?id=yY254PQ0&n=1',
  '',
].join('\n');

describe('rewriteMasterPlaylist', () => {
  it('points the media playlist at our origin with the token attached', () => {
    const out = rewriteMasterPlaylist(MASTER, OPTS) as string;

    expect(out).toContain(
      'https://balam-stream.innodev.kz/hls/media.m3u8?id=QXW4ZzIf&t=v1.cam.user.123.sig',
    );
    expect(out).not.toContain('hls/playlist.m3u8');
  });

  it('keeps the stream-info tag untouched', () => {
    const out = rewriteMasterPlaylist(MASTER, OPTS) as string;

    expect(out).toContain(
      '#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="hvc1.1.6.L153.B0"',
    );
  });
});

describe('rewriteMediaPlaylist', () => {
  it('rewrites the init segment inside the EXT-X-MAP tag', () => {
    const out = rewriteMediaPlaylist(MEDIA, OPTS) as string;

    expect(out).toContain(
      '#EXT-X-MAP:URI="https://balam-stream.innodev.kz/hls/init.mp4?id=yY254PQ0&t=v1.cam.user.123.sig"',
    );
  });

  it('rewrites every segment and preserves its index', () => {
    const out = rewriteMediaPlaylist(MEDIA, OPTS) as string;

    expect(out).toContain(
      'https://balam-stream.innodev.kz/hls/segment.m4s?id=yY254PQ0&n=0&t=v1.cam.user.123.sig',
    );
    expect(out).toContain(
      'https://balam-stream.innodev.kz/hls/segment.m4s?id=yY254PQ0&n=1&t=v1.cam.user.123.sig',
    );
  });

  it('leaves non-URI tags alone', () => {
    const out = rewriteMediaPlaylist(MEDIA, OPTS) as string;

    expect(out).toContain('#EXT-X-TARGETDURATION:1');
    expect(out).toContain('#EXTINF:0.500,');
  });
});

describe('rewrite allow-list', () => {
  it('rejects a playlist pointing at a filename we do not serve', () => {
    const hostile = ['#EXTM3U', '../../api/streams?src=cam03_sub', ''].join(
      '\n',
    );

    expect(rewriteMasterPlaylist(hostile, OPTS)).toBeNull();
  });

  it('rejects an absolute URI rather than passing an internal host through', () => {
    const leaky = [
      '#EXTM3U',
      'http://172.17.0.1:1984/api/hls/playlist.m3u8?id=abc',
      '',
    ].join('\n');

    expect(rewriteMasterPlaylist(leaky, OPTS)).toBeNull();
  });

  it('drops gateway query parameters other than the session id and index', () => {
    const extra = [
      '#EXTM3U',
      'segment.m4s?id=abc&n=2&debug=1&src=cam09',
      '',
    ].join('\n');

    const out = rewriteMediaPlaylist(extra, OPTS) as string;

    expect(out).toContain('id=abc&n=2&t=');
    expect(out).not.toContain('debug');
    expect(out).not.toContain('src=cam09');
  });
});
