import { Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as presignS3Url } from '@aws-sdk/s3-request-presigner';
import {
  FileUploadError,
  FileStorageMalformedKeyError,
  FileStorageNotFoundError,
  FileStorageTransientError,
} from '@/modules/content/domain/errors/file-upload.error';
import {
  FileStoragePort,
  FileStorageUploadInput,
  FileStorageUploadResult,
} from '../file-storage.port';

export interface S3FileStorageOptions {
  /** Bucket / container name the objects live in. */
  bucket: string;
  /**
   * S3 region. Most non-AWS S3-compatible providers (ps.kz, Yandex) ignore
   * this but the AWS SDK still requires a value — `us-east-1` is the
   * conventional placeholder.
   */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * S3-compatible endpoint. Leave undefined for real AWS S3.
   *   - ps.kz (Universal/Cold tariff): `https://object.pscloud.io`
   *   - Yandex Object Storage:         `https://storage.yandexcloud.net`
   */
  endpoint?: string;
  /**
   * `true` → path-style addressing (`<endpoint>/<bucket>/<key>`).
   * `false` (default) → virtual-hosted style (`<bucket>.<endpoint>/<key>`),
   * which is what ps.kz documents (`%(bucket)s.object.pscloud.io`).
   */
  forcePathStyle?: boolean;
  /**
   * URL prefix returned from `upload`/`getSignedUrl`. Defaults to the
   * auth-guarded `MediaController` route so uploaded media is served through
   * the backend (JWT + tenant scope) rather than directly off a public
   * bucket — the bucket stays PRIVATE. Must NOT include a trailing slash.
   */
  urlPrefix?: string;
  /** TTL applied by `getSignedUrl` (seconds). Default 900 (15 min). */
  signedUrlTtlSeconds?: number;
}

// Mirrors LocalFileStorageAdapter — uploaded media is addressed via the
// versioned, auth-guarded MediaController route, NOT a public bucket URL.
// The S3 bucket holds the same key (`<kg>/<…>/<uuid>.<ext>`); the public
// URL only ever points back at our own backend so every fetch passes
// JwtAuthGuard + KindergartenScopeGuard.
const DEFAULT_URL_PREFIX = '/api/v1/media';
const DEFAULT_SIGNED_URL_TTL_SECONDS = 900;

/**
 * S3-compatible implementation of `FileStoragePort` (B17 Phase B).
 *
 * Works against any S3-API endpoint — real AWS S3, ps.kz Object Storage
 * (`object.pscloud.io`), Yandex Object Storage — selected purely by
 * `endpoint` / `forcePathStyle` config. No bucket-side public access is
 * required or expected: `upload` returns the same `/api/v1/media/<key>`
 * URL the local adapter does, so `MediaController.stream()` proxies the
 * bytes (calling `download(key)`) behind auth. Keeping the bucket PRIVATE
 * is what preserves tenant isolation for children's media.
 *
 * Error mapping (B22b T9 discriminated hierarchy):
 *   - structurally invalid key            → FileStorageMalformedKeyError (400)
 *   - NoSuchKey / 404                      → FileStorageNotFoundError    (404)
 *   - 5xx / network / timeout              → FileStorageTransientError   (503)
 *   - anything else on write              → FileUploadError('upload_failed')
 */
@Injectable()
export class S3FileStorageAdapter extends FileStoragePort {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly urlPrefix: string;
  private readonly signedTtl: number;

  /**
   * @param client Optional pre-built client — injected by unit tests with a
   * hand-written fake `send()`. Production wiring omits it so the adapter
   * builds a real `S3Client` from `options`.
   */
  constructor(options: S3FileStorageOptions, client?: S3Client) {
    super();
    this.bucket = options.bucket;
    this.urlPrefix = (options.urlPrefix ?? DEFAULT_URL_PREFIX).replace(
      /\/+$/,
      '',
    );
    this.signedTtl =
      options.signedUrlTtlSeconds ?? DEFAULT_SIGNED_URL_TTL_SECONDS;
    this.client =
      client ??
      new S3Client({
        region: options.region,
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle ?? false,
        credentials: {
          accessKeyId: options.accessKeyId,
          secretAccessKey: options.secretAccessKey,
        },
      });
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
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.buffer,
          ContentType: input.contentType,
          ContentLength: input.buffer.length,
        }),
      );
    } catch (err) {
      if (this.isTransient(err)) {
        throw new FileStorageTransientError(`s3_${this.errName(err)}`);
      }
      throw new FileUploadError('upload_failed', `s3_${this.errName(err)}`);
    }
    return {
      url: `${this.urlPrefix}/${input.key}`,
      key: input.key,
      bytes: input.buffer.length,
    };
  }

  async download(key: string): Promise<Buffer> {
    this.assertSafeKey(key);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = out.Body;
      if (!body) throw new FileStorageNotFoundError(key);
      const bytes = await body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (err) {
      if (err instanceof FileStorageNotFoundError) throw err;
      if (this.isNotFound(err)) throw new FileStorageNotFoundError(key);
      if (this.isTransient(err)) {
        throw new FileStorageTransientError(`s3_${this.errName(err)}`);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    this.assertSafeKey(key);
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (err) {
      // Missing object is a no-op (idempotent — retry-safe for story-cleanup).
      if (this.isNotFound(err)) return;
      if (this.isTransient(err)) {
        throw new FileStorageTransientError(`s3_${this.errName(err)}`);
      }
      throw new FileUploadError(
        'upload_failed',
        `s3_delete_${this.errName(err)}`,
      );
    }
  }

  async getSignedUrl(key: string, ttlSeconds?: number): Promise<string> {
    this.assertSafeKey(key);
    return presignS3Url(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: ttlSeconds ?? this.signedTtl },
    );
  }

  // --- error classification -------------------------------------------------

  private httpStatus(err: unknown): number | undefined {
    if (typeof err === 'object' && err !== null && '$metadata' in err) {
      const md = (err as { $metadata?: { httpStatusCode?: number } }).$metadata;
      return md?.httpStatusCode;
    }
    return undefined;
  }

  private errName(err: unknown): string {
    return err instanceof Error && err.name ? err.name : 'unknown';
  }

  /** NoSuchKey / NotFound name OR a 404 status. */
  private isNotFound(err: unknown): boolean {
    const name = this.errName(err);
    return (
      name === 'NoSuchKey' ||
      name === 'NotFound' ||
      this.httpStatus(err) === 404
    );
  }

  /**
   * 5xx responses OR errors with no HTTP status (connection refused, DNS,
   * timeout, socket hang-up) — the request may succeed on retry.
   */
  private isTransient(err: unknown): boolean {
    const status = this.httpStatus(err);
    if (status === undefined) return true;
    return status >= 500;
  }

  /**
   * Path-traversal / structural-key guard — identical contract to
   * LocalFileStorageAdapter.assertSafeKey. Keys are server-generated
   * (`<kg>/<…>/<uuid>.<ext>`) so this is defence-in-depth against any future
   * caller-supplied key. Decode-then-validate catches percent-encoded `..`.
   */
  private assertSafeKey(key: string): void {
    if (key.length === 0) {
      throw new FileUploadError('media_url_required');
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(key);
    } catch {
      throw new FileStorageMalformedKeyError('malformed_percent_encoding');
    }
    if (
      decoded.startsWith('/') ||
      decoded.startsWith('\\') ||
      decoded.includes('..') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      throw new FileStorageMalformedKeyError('path_traversal_attempt');
    }
  }
}
