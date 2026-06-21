import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import { MediaSignInterceptor } from './media-sign.interceptor';

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
});
