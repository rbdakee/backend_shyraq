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
 * Tells the interceptor which stored strings point at OUR private bucket and
 * therefore must be presigned. Built once from the same env the storage
 * adapter is wired with (see `ContentModule.readS3StorageOptions`).
 */
export interface MediaUrlConfig {
  /** Canonical route prefix uploads emit, no trailing slash (`/api/v1/media`). */
  urlPrefix: string;
  /** Legacy pre-SP5 static prefix, no trailing slash (`/static`). */
  legacyPrefix: string;
  /**
   * Absolute URL bases that address our bucket directly, e.g.
   * `https://balam-media-dev.object.pscloud.io/` (virtual-hosted) and
   * `https://object.pscloud.io/balam-media-dev/` (path-style). Anything that
   * starts with one of these is one of our objects — strip the base (and any
   * stale `?X-Amz-…` signature) to recover the key and re-sign it. Empty when
   * no S3 endpoint is configured (local adapter / tests).
   */
  bucketBases: string[];
}

/**
 * Reads the bucket addressing config from the environment. Mirrors the
 * adapter wiring: virtual-hosted vs path-style are BOTH registered so legacy
 * rows persisted under either addressing style are recognised regardless of
 * the current `FILE_STORAGE_FORCE_PATH_STYLE` setting.
 */
export function readMediaUrlConfig(): MediaUrlConfig {
  const urlPrefix = (process.env.FILE_STORAGE_URL_PREFIX || '/api/v1/media')
    .trim()
    .replace(/\/+$/, '');
  const bucket = process.env.FILE_STORAGE_BUCKET;
  const endpoint = process.env.FILE_STORAGE_ENDPOINT;
  const bucketBases: string[] = [];
  if (bucket && endpoint) {
    try {
      const u = new URL(endpoint);
      bucketBases.push(`${u.protocol}//${bucket}.${u.host}/`); // virtual-hosted
      bucketBases.push(`${u.protocol}//${u.host}/${bucket}/`); // path-style
    } catch {
      // Malformed endpoint — leave bucketBases empty; route-prefix forms still work.
    }
  }
  return { urlPrefix, legacyPrefix: '/static', bucketBases };
}

/**
 * Returns the storage key for a string that references OUR bucket, or null if
 * the string is not one of ours (external CDN, data URI, plain text, …) and
 * must be left untouched.
 *
 * Recognised forms:
 *   - `<urlPrefix>/<key>`              — current uploads (`/api/v1/media/<key>`)
 *   - `/static/<key>`                  — legacy pre-SP5 rows
 *   - `http(s)://<anyHost>/api/v1/media/<key>` — absolute link to our OWN
 *     backend route. Some client-populated fields bake the backend base URL
 *     in (e.g. `children.photo_url` = `http://<host>:<port>/api/v1/media/…`).
 *     Matched on the URL PATH, host-agnostic — the host is an IP in dev and a
 *     domain in prod, but the `/api/v1/media/` path is the stable marker.
 *   - `<bucketBase><key>[?sig]`        — absolute bucket URLs (stale sig stripped)
 */
export function resolveMediaKey(
  value: string,
  cfg: MediaUrlConfig,
): string | null {
  if (!value) return null;
  const stripKey = (raw: string): string | null => {
    const key = raw.split('?')[0];
    return key.length > 0 ? key : null;
  };
  const fromPath = (path: string): string | null => {
    if (path.startsWith(`${cfg.urlPrefix}/`)) {
      return stripKey(path.slice(cfg.urlPrefix.length + 1));
    }
    if (path.startsWith(`${cfg.legacyPrefix}/`)) {
      return stripKey(path.slice(cfg.legacyPrefix.length + 1));
    }
    return null;
  };

  if (/^https?:\/\//i.test(value)) {
    // Direct bucket object URL → key is everything after the bucket base.
    for (const base of cfg.bucketBases) {
      if (value.startsWith(base)) return stripKey(value.slice(base.length));
    }
    // Absolute link to our own /api/v1/media (or legacy /static) route.
    try {
      return fromPath(new URL(value).pathname);
    } catch {
      return null;
    }
  }
  // Relative route forms.
  return fromPath(value);
}

/**
 * Global response interceptor (sibling of `TenantContextInterceptor`) that
 * rewrites every reference to a private-bucket object in a successful response
 * body into a short-lived presigned URL.
 *
 * Why this exists: the bucket is PRIVATE and JWT is accepted only via the
 * `Authorization: Bearer` header (see `JwtAuthGuard`), so a browser `<img>`
 * tag cannot fetch `/api/v1/media/...` directly (no header on image loads).
 * A presigned URL carries its signature in the query string, so the client
 * can drop it straight into `<img src>` with no auth header — and the bytes
 * stream S3 → browser without the backend proxying them through memory.
 *
 * Coverage: it signs ANY string that resolves to one of our keys via
 * `resolveMediaKey` — the current `/api/v1/media/<key>` route, legacy
 * `/static/<key>` rows, and absolute bucket URLs (child/staff avatars, meal
 * photos, trusted-person photos, diagnostics/timeline media — fields that are
 * client-populated and were stored before this presigning existed). External
 * CDN URLs and non-matching strings are left untouched.
 *
 * Why an interceptor (not per-presenter resolution): media URLs surface from
 * many presenters (all static, no DI). Centralising here covers every current
 * and future endpoint uniformly and keeps presenters dependency-free.
 *
 * Degradation: `LocalFileStorageAdapter.getSignedUrl` returns the same
 * `/api/v1/media/<key>` (local files have no signed access), so in dev / e2e
 * this is a no-op and the auth-gated `MediaController` keeps serving as the
 * fallback. Signing failures fall back to the original URL. Tenant isolation
 * is preserved upstream: a response only contains URLs for resources the
 * caller was already allowed to read.
 *
 * Opt-out: handlers tagged `@SkipMediaSign()` (e.g. the standalone
 * `upload-media` endpoint that must return the canonical, storable key).
 */
@Injectable()
export class MediaSignInterceptor implements NestInterceptor {
  /**
   * Bucket addressing config, resolved from env at construction. It is a
   * PLAIN FIELD, not a constructor parameter: Nest tries to DI-resolve every
   * constructor argument, and a 3rd arg typed as an interface (erased to
   * `Object` at runtime) has no provider → `UnknownDependenciesException` at
   * bootstrap (the whole app fails to start). Unit tests override this field
   * after instantiation instead.
   */
  cfg: MediaUrlConfig = readMediaUrlConfig();

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
    const originals = collectMediaUrls(body, this.cfg);
    if (originals.size === 0) return body;
    const signed = await this.signAll(originals);
    replaceMediaUrls(body, signed);
    return body;
  }

  /**
   * Maps each original string → its presigned URL. Multiple originals can
   * resolve to the same key (e.g. `/api/v1/media/k` and an absolute bucket
   * URL for `k`); the per-key cache presigns each key only once. Presigning
   * is a local HMAC (no network round-trip), so this stays cheap.
   */
  private async signAll(originals: Set<string>): Promise<Map<string, string>> {
    const keyCache = new Map<string, Promise<string>>();
    const signKey = (key: string): Promise<string> => {
      const cached = keyCache.get(key);
      if (cached) return cached;
      const p = this.storage.getSignedUrl(key, SIGNED_URL_TTL_SECONDS);
      keyCache.set(key, p);
      return p;
    };

    const entries = await Promise.all(
      [...originals].map(async (url): Promise<readonly [string, string]> => {
        const key = resolveMediaKey(url, this.cfg);
        if (!key) return [url, url] as const;
        try {
          return [url, await signKey(key)] as const;
        } catch {
          // Leave the original so a fallback path can still try to serve it
          // rather than rendering a broken image.
          return [url, url] as const;
        }
      }),
    );
    return new Map(entries);
  }
}

/** Recursively gathers every string that resolves to one of our keys. */
function collectMediaUrls(
  node: unknown,
  cfg: MediaUrlConfig,
  acc = new Set<string>(),
): Set<string> {
  if (typeof node === 'string') {
    if (resolveMediaKey(node, cfg) !== null) acc.add(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const el of node) collectMediaUrls(el, cfg, acc);
    return acc;
  }
  if (isWalkable(node)) {
    for (const value of Object.values(node)) collectMediaUrls(value, cfg, acc);
  }
  return acc;
}

/** Recursively replaces matched strings in place using the signed map. */
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
