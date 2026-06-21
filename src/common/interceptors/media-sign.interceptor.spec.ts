import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import {
  MediaSignInterceptor,
  MediaUrlConfig,
  resolveMediaKey,
} from './media-sign.interceptor';

// Explicit config used by tests (production reads this from env). Mirrors the
// ps.kz dev wiring so the absolute-bucket-URL branch is exercised.
const TEST_CFG: MediaUrlConfig = {
  urlPrefix: '/api/v1/media',
  legacyPrefix: '/static',
  bucketBases: [
    'https://balam-media-dev.object.pscloud.io/',
    'https://object.pscloud.io/balam-media-dev/',
  ],
};

/**
 * Hand-written in-memory fake (CLAUDE.md §7 — no Jest auto-mock). Records the
 * (key, ttl) of every getSignedUrl call and returns a deterministic signed URL.
 */
class FakeFileStorage extends FileStoragePort {
  public readonly signCalls: Array<{ key: string; ttl?: number }> = [];

  upload(): never {
    throw new Error('not used in these tests');
  }
  download(): never {
    throw new Error('not used in these tests');
  }
  delete(): Promise<void> {
    return Promise.resolve();
  }
  getSignedUrl(key: string, ttlSeconds?: number): Promise<string> {
    this.signCalls.push({ key, ttl: ttlSeconds });
    return Promise.resolve(
      `https://cdn.example/${key}?sig=abc&ttl=${ttlSeconds}`,
    );
  }
}

function makeCtx(): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function reflectorReturning(skip: boolean): Reflector {
  return { getAllAndOverride: () => skip } as unknown as Reflector;
}

function handlerOf(body: unknown): CallHandler {
  return { handle: () => of(body) };
}

describe('MediaSignInterceptor', () => {
  let storage: FakeFileStorage;

  beforeEach(() => {
    storage = new FakeFileStorage();
  });

  function run(body: unknown, skip = false): Promise<unknown> {
    const interceptor = new MediaSignInterceptor(
      storage,
      reflectorReturning(skip),
      TEST_CFG,
    );
    return lastValueFrom(interceptor.intercept(makeCtx(), handlerOf(body)));
  }

  it('rewrites a media_urls array into presigned URLs with a 1h TTL', async () => {
    const body = {
      media_urls: ['/api/v1/media/kg-1/2026-06/abc.png'],
      title: 'hello',
    };

    const out = (await run(body)) as typeof body;

    expect(out.media_urls[0]).toBe(
      'https://cdn.example/kg-1/2026-06/abc.png?sig=abc&ttl=3600',
    );
    expect(storage.signCalls).toEqual([
      { key: 'kg-1/2026-06/abc.png', ttl: 3600 },
    ]);
  });

  it('leaves non-media strings untouched', async () => {
    const body = {
      title: 'A regular title',
      external: 'https://example.com/photo.png',
      media_url: '/api/v1/media/kg-1/2026-06/x.jpg',
    };

    const out = (await run(body)) as typeof body;

    expect(out.title).toBe('A regular title');
    expect(out.external).toBe('https://example.com/photo.png');
    expect(out.media_url).toMatch(/^https:\/\/cdn\.example\//);
  });

  it('recurses into nested arrays of items (feed / paged shapes)', async () => {
    const body: {
      items: Array<{ id: string; mediaUrls?: string[]; media_url?: string }>;
      nextCursor: string | null;
    } = {
      items: [
        { id: '1', mediaUrls: ['/api/v1/media/kg-1/2026-06/a.png'] },
        { id: '2', media_url: '/api/v1/media/kg-1/2026-06/b.png' },
      ],
      nextCursor: null,
    };

    const out = (await run(body)) as typeof body;

    expect(out.items[0].mediaUrls?.[0]).toMatch(
      /cdn\.example\/kg-1\/2026-06\/a\.png/,
    );
    expect(out.items[1].media_url).toMatch(
      /cdn\.example\/kg-1\/2026-06\/b\.png/,
    );
  });

  it('signs each unique URL only once', async () => {
    const url = '/api/v1/media/kg-1/2026-06/dup.png';
    const body = { a: url, b: url, nested: { c: url } };

    await run(body);

    expect(storage.signCalls).toHaveLength(1);
  });

  it('passes the response through unchanged when @SkipMediaSign is set', async () => {
    const body = {
      url: '/api/v1/media/kg-1/2026-06/keep.png',
      key: 'kg-1/2026-06/keep.png',
    };

    const out = (await run(body, true)) as typeof body;

    expect(out.url).toBe('/api/v1/media/kg-1/2026-06/keep.png');
    expect(storage.signCalls).toHaveLength(0);
  });

  it('falls back to the original URL when signing throws', async () => {
    storage.getSignedUrl = () => Promise.reject(new Error('s3 down'));
    const body = { media_url: '/api/v1/media/kg-1/2026-06/fail.png' };

    const out = (await run(body)) as typeof body;

    expect(out.media_url).toBe('/api/v1/media/kg-1/2026-06/fail.png');
  });

  it('returns the body untouched when there are no media URLs', async () => {
    const body = { title: 'no media here', count: 3, ok: true };

    const out = await run(body);

    expect(out).toBe(body);
    expect(storage.signCalls).toHaveLength(0);
  });

  it('signs legacy /static/<key> photos (pre-SP5 rows)', async () => {
    const body = { photo_url: '/static/kg-1/2025-01/legacy.jpg' };

    const out = (await run(body)) as typeof body;

    expect(out.photo_url).toMatch(/cdn\.example\/kg-1\/2025-01\/legacy\.jpg/);
    expect(storage.signCalls).toEqual([
      { key: 'kg-1/2025-01/legacy.jpg', ttl: 3600 },
    ]);
  });

  it('re-signs absolute bucket URLs and strips a stale signature', async () => {
    const body = {
      avatar_url:
        'https://balam-media-dev.object.pscloud.io/kg-1/2025-01/avatar.jpg?X-Amz-Signature=stale&X-Amz-Expires=900',
      path_style:
        'https://object.pscloud.io/balam-media-dev/kg-1/2025-01/p.png',
    };

    const out = (await run(body)) as typeof body;

    expect(out.avatar_url).toBe(
      'https://cdn.example/kg-1/2025-01/avatar.jpg?sig=abc&ttl=3600',
    );
    expect(out.path_style).toBe(
      'https://cdn.example/kg-1/2025-01/p.png?sig=abc&ttl=3600',
    );
    expect(storage.signCalls).toEqual(
      expect.arrayContaining([
        { key: 'kg-1/2025-01/avatar.jpg', ttl: 3600 },
        { key: 'kg-1/2025-01/p.png', ttl: 3600 },
      ]),
    );
  });

  it('leaves genuine external CDN URLs (different host) untouched', async () => {
    const body = { avatar_url: 'https://cdn.shyraq.app/u/abcd1234.jpg' };

    const out = (await run(body)) as typeof body;

    expect(out.avatar_url).toBe('https://cdn.shyraq.app/u/abcd1234.jpg');
    expect(storage.signCalls).toHaveLength(0);
  });

  it('signs absolute backend-host /api/v1/media URLs (children.photo_url shape)', async () => {
    // The real stored shape: client baked the backend base URL onto the
    // canonical media route (http://<ip>:<port>/api/v1/media/<key>).
    const body = {
      photo_url:
        'http://194.238.42.156:5678/api/v1/media/kg-1/2026-06/child.jpg',
    };

    const out = (await run(body)) as typeof body;

    expect(out.photo_url).toBe(
      'https://cdn.example/kg-1/2026-06/child.jpg?sig=abc&ttl=3600',
    );
    expect(storage.signCalls).toEqual([
      { key: 'kg-1/2026-06/child.jpg', ttl: 3600 },
    ]);
  });
});

describe('resolveMediaKey', () => {
  const cfg: MediaUrlConfig = {
    urlPrefix: '/api/v1/media',
    legacyPrefix: '/static',
    bucketBases: [
      'https://balam-media-dev.object.pscloud.io/',
      'https://object.pscloud.io/balam-media-dev/',
    ],
  };

  it('extracts the key from each recognised form', () => {
    expect(resolveMediaKey('/api/v1/media/a/b/c.png', cfg)).toBe('a/b/c.png');
    expect(resolveMediaKey('/static/a/b/c.png', cfg)).toBe('a/b/c.png');
    expect(
      resolveMediaKey(
        'https://balam-media-dev.object.pscloud.io/a/b/c.png?X-Amz-Signature=x',
        cfg,
      ),
    ).toBe('a/b/c.png');
    expect(
      resolveMediaKey(
        'https://object.pscloud.io/balam-media-dev/a/b/c.png',
        cfg,
      ),
    ).toBe('a/b/c.png');
    // absolute backend-host URL (the real children.photo_url shape)
    expect(
      resolveMediaKey('http://194.238.42.156:5678/api/v1/media/a/b/c.png', cfg),
    ).toBe('a/b/c.png');
    expect(
      resolveMediaKey('https://api.shyraq.app/static/a/b/c.png', cfg),
    ).toBe('a/b/c.png');
  });

  it('returns null for external / unrelated strings', () => {
    expect(resolveMediaKey('https://cdn.shyraq.app/x.jpg', cfg)).toBeNull();
    expect(resolveMediaKey('just a title', cfg)).toBeNull();
    expect(resolveMediaKey('/api/v1/media/', cfg)).toBeNull();
  });
});
