import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Injectable } from '@nestjs/common';
import { FileUploadError } from '@/modules/content/domain/errors/file-upload.error';
import {
  FileStoragePort,
  FileStorageUploadInput,
  FileStorageUploadResult,
} from '../file-storage.port';

export interface LocalFileStorageOptions {
  /**
   * Filesystem path under which all uploaded files live. Resolved against
   * `process.cwd()` if relative. The directory is created on first write
   * (`fs.mkdir(..., { recursive: true })`).
   */
  uploadsDir: string;
  /**
   * URL prefix the public-facing static handler serves the directory
   * under. Defaults to `/static`. Must NOT include a trailing slash.
   * Returned `url` is `<urlPrefix>/<key>`.
   */
  urlPrefix?: string;
}

// FINDINGS.md SP5 — URL prefix moved from `/static` (public, unauth) to
// the versioned, auth-guarded `MediaController` route. Files on disk still
// live at `<uploadsDir>/<key>`; only the public URL exposed to clients
// changes so every fetch goes through JwtAuthGuard + KindergartenScopeGuard
// + the controller's path-kg match.
const DEFAULT_URL_PREFIX = '/api/v1/media';

/**
 * Local-disk implementation of `FileStoragePort` — Phase A default.
 *
 * Files land under `<uploadsDir>/<key>`. Public URLs are
 * `<urlPrefix>/<key>` (served by `MediaController` since FINDINGS.md SP5;
 * was `ServeStaticModule` previously, removed because it bypassed every
 * NestJS guard). `getSignedUrl` returns the same URL — local files have
 * no concept of signed access; the parent app sees them via the same
 * path during the 24h window the story is alive.
 *
 * Defence-in-depth: rejects keys containing `..` so a malicious caller
 * cannot escape the uploads root via path traversal.
 */
@Injectable()
export class LocalFileStorageAdapter extends FileStoragePort {
  private readonly uploadsDir: string;
  private readonly urlPrefix: string;

  constructor(options: LocalFileStorageOptions) {
    super();
    this.uploadsDir = resolve(process.cwd(), options.uploadsDir);
    this.urlPrefix = (options.urlPrefix ?? DEFAULT_URL_PREFIX).replace(
      /\/+$/,
      '',
    );
  }

  async upload(
    input: FileStorageUploadInput,
  ): Promise<FileStorageUploadResult> {
    this.assertSafeKey(input.key);
    if (
      input.maxBytes !== undefined &&
      input.maxBytes > 0 &&
      input.buffer.length > input.maxBytes
    ) {
      throw new FileUploadError('file_too_large');
    }
    const fullPath = join(this.uploadsDir, input.key);
    try {
      await fs.mkdir(dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, input.buffer);
    } catch (err) {
      const code =
        err instanceof Error && (err as NodeJS.ErrnoException).code
          ? (err as NodeJS.ErrnoException).code
          : 'unknown';
      throw new FileUploadError('upload_failed', `local_${code}`);
    }
    return {
      url: `${this.urlPrefix}/${input.key}`,
      key: input.key,
      bytes: input.buffer.length,
    };
  }

  async download(key: string): Promise<Buffer> {
    this.assertSafeKey(key);
    const fullPath = join(this.uploadsDir, key);
    return fs.readFile(fullPath);
  }

  async delete(key: string): Promise<void> {
    this.assertSafeKey(key);
    const fullPath = join(this.uploadsDir, key);
    try {
      await fs.unlink(fullPath);
    } catch (err) {
      // ENOENT — file already gone — is idempotent. Anything else is
      // logged-and-swallow (the caller is the cleanup cron / best-effort
      // path; we don't want a stuck file to break the story delete flow).
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw new FileUploadError(
        'upload_failed',
        `local_delete_${code ?? 'unknown'}`,
      );
    }
  }

  getSignedUrl(key: string, _ttlSeconds?: number): Promise<string> {
    this.assertSafeKey(key);
    return Promise.resolve(`${this.urlPrefix}/${key}`);
  }

  /**
   * Path-traversal guard. Phase A keys are generated server-side via
   * `<kg>/<yyyy-mm>/<uuid>.<ext>` so this is defence-in-depth — but
   * cheap insurance against future code paths that accept
   * caller-supplied keys.
   */
  private assertSafeKey(key: string): void {
    if (key.length === 0) {
      throw new FileUploadError('media_url_required');
    }
    // Reject absolute paths AND any `..` segments. We tolerate forward-
    // slashes only (S3-style keys) — backslashes are rejected to keep
    // semantics consistent across platforms.
    if (
      key.startsWith('/') ||
      key.startsWith('\\') ||
      key.includes('..') ||
      key.includes('\\')
    ) {
      throw new FileUploadError('upload_failed', 'invalid_key');
    }
  }
}
