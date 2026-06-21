import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, Observable } from 'rxjs';
import { switchMap } from 'rxjs/operators';
import { FileStoragePort } from '@/shared-kernel/storage/file-storage.port';
import { SKIP_MEDIA_SIGN_KEY } from '../decorators/skip-media-sign.decorator';

/**
 * Presigned-URL TTL (seconds). 1 hour — wider than the adapter's 15-min
 * default so a parent who keeps the feed open / scrolls back through stories
 * does not hit an expired image link mid-session. The file itself stays in
 * the PRIVATE bucket forever (until story-cleanup / delete); only the signed
 * LINK expires after this window.
 */
const SIGNED_URL_TTL_SECONDS = 3600;

/**
 * Matches the canonical media URL both storage adapters emit
 * (`/api/v1/media/<kgId>/<yyyy-mm>/<uuid>.<ext>`). Capture group 1 is the
 * storage key fed to `FileStoragePort.getSignedUrl`. Kept in sync with
 * `DEFAULT_URL_PREFIX` in the storage adapters; a custom
 * `FILE_STORAGE_URL_PREFIX` would need this prefix updated too.
 */
const MEDIA_URL_RE = /^\/api\/v1\/media\/(.+)$/;

/**
 * Global response interceptor (sibling of `TenantContextInterceptor`) that
 * rewrites every canonical media URL in a successful response body into a
 * short-lived presigned URL pointing straight at the object store.
 *
 * Why this exists: the bucket is PRIVATE and JWT is accepted only via the
 * `Authorization: Bearer` header (see `JwtAuthGuard`), so a browser `<img>`
 * tag cannot fetch `/api/v1/media/...` directly (no header on image loads).
 * A presigned URL carries its signature in the query string, so the client
 * can drop it straight into `<img src>` with no auth header — and the bytes
 * stream S3 → browser without the backend proxying them through memory.
 *
 * Why an interceptor (not per-presenter resolution): media URLs surface from
 * content, stories, timeline and diagnostics presenters (all static, no DI).
 * Centralising here covers every current and future endpoint uniformly and
 * keeps the presenters dependency-free.
 *
 * Degradation: `LocalFileStorageAdapter.getSignedUrl` returns the same
 * `/api/v1/media/<key>` (local files have no signed access), so in dev / e2e
 * this is a no-op and the auth-gated `MediaController` keeps serving as the
 * fallback. Signing failures fall back to the original URL for the same
 * reason. Tenant isolation is preserved upstream: a response only ever
 * contains URLs for resources the caller was already allowed to read.
 *
 * Opt-out: handlers tagged `@SkipMediaSign()` (e.g. the standalone
 * `upload-media` endpoint that must return the canonical, storable key).
 */
@Injectable()
export class MediaSignInterceptor implements NestInterceptor {
  constructor(
    @Inject(FileStoragePort) private readonly storage: FileStoragePort,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();

    const skip =
      this.reflector.getAllAndOverride<boolean>(SKIP_MEDIA_SIGN_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? false;
    if (skip) return next.handle();

    return next.handle().pipe(switchMap((body) => from(this.transform(body))));
  }

  private async transform(body: unknown): Promise<unknown> {
    const urls = collectMediaUrls(body);
    if (urls.size === 0) return body;
    const signed = await this.signAll(urls);
    replaceMediaUrls(body, signed);
    return body;
  }

  /**
   * Signs each unique URL once (dedup-by-URL → at most one presign per key).
   * Presigning is a local HMAC computation (no network round-trip), so this
   * stays cheap even for a feed full of media.
   */
  private async signAll(urls: Set<string>): Promise<Map<string, string>> {
    const entries = await Promise.all(
      [...urls].map(async (url): Promise<readonly [string, string]> => {
        const key = MEDIA_URL_RE.exec(url)?.[1];
        if (!key) return [url, url] as const;
        try {
          const fresh = await this.storage.getSignedUrl(
            key,
            SIGNED_URL_TTL_SECONDS,
          );
          return [url, fresh] as const;
        } catch {
          // Leave the original URL so the auth-gated MediaController fallback
          // can still serve it rather than rendering a broken image.
          return [url, url] as const;
        }
      }),
    );
    return new Map(entries);
  }
}

/** Recursively gathers every canonical media URL string into a Set. */
function collectMediaUrls(node: unknown, acc = new Set<string>()): Set<string> {
  if (typeof node === 'string') {
    if (MEDIA_URL_RE.test(node)) acc.add(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const el of node) collectMediaUrls(el, acc);
    return acc;
  }
  if (isWalkable(node)) {
    for (const value of Object.values(node)) collectMediaUrls(value, acc);
  }
  return acc;
}

/** Recursively replaces media URL strings in place using the signed map. */
function replaceMediaUrls(node: unknown, signed: Map<string, string>): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const el = node[i];
      if (typeof el === 'string' && signed.has(el)) {
        node[i] = signed.get(el);
      } else {
        replaceMediaUrls(el, signed);
      }
    }
    return;
  }
  if (isWalkable(node)) {
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === 'string' && signed.has(v)) {
        node[k] = signed.get(v);
      } else {
        replaceMediaUrls(v, signed);
      }
    }
  }
}

/**
 * True for plain objects / class instances we should recurse into. Excludes
 * arrays (handled separately), `Date` and `Buffer` so we never iterate their
 * internals.
 */
function isWalkable(node: unknown): node is Record<string, unknown> {
  return (
    node !== null &&
    typeof node === 'object' &&
    !Array.isArray(node) &&
    !(node instanceof Date) &&
    !Buffer.isBuffer(node)
  );
}
