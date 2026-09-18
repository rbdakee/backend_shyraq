/**
 * Rewrites the playlists the media gateway produces so the player only ever
 * sees our own origin and our own token.
 *
 * The gateway emits relative URIs (`hls/playlist.m3u8?id=…`, `segment.m4s?…`)
 * that resolve against its private address, and it has no idea a token needs
 * to travel with them. So every URI line is replaced with an absolute path on
 * the streaming host carrying `t=<token>`.
 *
 * The rewrite is an allow-list, not a search-and-replace: only the four
 * filenames the gateway is supposed to emit are accepted, and anything else
 * makes the whole rewrite fail. A playlist we do not fully understand is not
 * served half-translated — that is how internal hostnames end up in a client.
 */

const PLAYLIST_BASE_PATH = '/hls';

/** `playlist.m3u8` is the gateway's name for what we expose as `media.m3u8`. */
const URI_ALLOW_LIST: Record<string, string> = {
  'playlist.m3u8': 'media.m3u8',
  'init.mp4': 'init.mp4',
  'segment.m4s': 'segment.m4s',
  'segment.ts': 'segment.ts',
};

export interface RewriteOptions {
  /** Origin the apps talk to, e.g. `https://balam-stream.innodev.kz`. */
  publicBase: string;
  token: string;
}

/** Master playlist: one `#EXT-X-STREAM-INF` line plus the media playlist URI. */
export function rewriteMasterPlaylist(
  body: string,
  opts: RewriteOptions,
): string | null {
  return rewriteLines(body, opts);
}

/** Media playlist: `#EXT-X-MAP` init segment plus the segment URIs. */
export function rewriteMediaPlaylist(
  body: string,
  opts: RewriteOptions,
): string | null {
  return rewriteLines(body, opts);
}

function rewriteLines(body: string, opts: RewriteOptions): string | null {
  const out: string[] = [];

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === '') {
      out.push(rawLine);
      continue;
    }

    if (line.startsWith('#')) {
      // `#EXT-X-MAP:URI="init.mp4?id=…"` is the only tag carrying a URI.
      const map = line.match(/^(#EXT-X-MAP:.*URI=")([^"]+)(".*)$/);
      if (!map) {
        out.push(rawLine);
        continue;
      }
      const rewritten = rewriteUri(map[2], opts);
      if (rewritten === null) return null;
      out.push(`${map[1]}${rewritten}${map[3]}`);
      continue;
    }

    const rewritten = rewriteUri(line, opts);
    if (rewritten === null) return null;
    out.push(rewritten);
  }

  return out.join('\n');
}

function rewriteUri(uri: string, opts: RewriteOptions): string | null {
  // The gateway prefixes the media playlist with `hls/`; segments come bare.
  const withoutPrefix = uri.replace(/^hls\//, '');
  const [name, query = ''] = splitOnce(withoutPrefix, '?');

  const mapped = URI_ALLOW_LIST[name];
  if (!mapped) return null;

  const params = new URLSearchParams(query);
  // A gateway session id is the only parameter we pass through; `n` indexes
  // the segment. Anything else is dropped rather than forwarded blindly.
  const passthrough = new URLSearchParams();
  for (const key of ['id', 'n']) {
    const value = params.get(key);
    if (value !== null) passthrough.set(key, value);
  }
  passthrough.set('t', opts.token);

  return `${opts.publicBase}${PLAYLIST_BASE_PATH}/${mapped}?${passthrough.toString()}`;
}

function splitOnce(value: string, separator: string): [string, string?] {
  const at = value.indexOf(separator);
  if (at === -1) return [value];
  return [value.slice(0, at), value.slice(at + 1)];
}
