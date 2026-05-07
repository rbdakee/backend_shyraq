/**
 * File-storage abstraction (B17 §9.6 / §9.x).
 *
 * The cross-module port lives in `src/shared-kernel/` because it is used
 * both by Content (for stories + post media) and — eventually — by other
 * modules that ship attachments (B22 chat, B19 specialist reports).
 *
 * Phase A ships only the `LocalFileStorageAdapter`; Phase B will add S3 /
 * Yandex Object Storage adapters behind the same port. The
 * `FILE_STORAGE_PROVIDER` env-switch in `ContentModule` selects which
 * adapter is bound at runtime.
 *
 * Layer rule: this file lives in `shared-kernel/` so it has zero
 * dependencies on `@nestjs/*` or any module-level types. Adapters are
 * `@Injectable()` and live alongside the port under
 * `shared-kernel/storage/adapters/`.
 */

export interface FileStorageUploadInput {
  /** Raw bytes of the file. */
  buffer: Buffer;
  /**
   * Storage key — path-relative, no leading slash. The service generates
   * this BEFORE calling `upload` so retries write to the same key (idempotent).
   * Convention: `<kgId>/<yyyy-mm>/<uuid>.<ext>`.
   */
  key: string;
  /** MIME content-type. Validated by the service before upload. */
  contentType: string;
  /**
   * Optional max-size in bytes. When set, the adapter MUST reject the
   * upload (`FileUploadError('file_too_large')`) if `buffer.length` exceeds
   * the limit. Phase A: enforced at the controller layer; this field
   * exists so service-layer code can pass through a per-flow limit.
   */
  maxBytes?: number;
}

export interface FileStorageUploadResult {
  /**
   * Public URL for the uploaded asset. For the local adapter this is
   * `/static/<key>` (served by ServeStaticModule). For Phase B S3 adapters
   * this would be a signed CloudFront / Yandex CDN URL.
   */
  url: string;
  /** The storage key (mirror of input.key). */
  key: string;
  /** Bytes actually written. */
  bytes: number;
}

export abstract class FileStoragePort {
  /**
   * Upload `buffer` under `key`. Adapter is responsible for creating any
   * intermediate directories / S3 key-prefixes. Throws
   * `FileUploadError('upload_failed', cause)` on infrastructure failure.
   */
  abstract upload(
    input: FileStorageUploadInput,
  ): Promise<FileStorageUploadResult>;

  /** Read raw bytes from `key`. Throws if missing. */
  abstract download(key: string): Promise<Buffer>;

  /**
   * Best-effort delete. Adapter MUST treat "not-found" as a no-op
   * (idempotent — retry-safe for the `story-cleanup` cron).
   */
  abstract delete(key: string): Promise<void>;

  /**
   * Optional signed URL with short TTL. Local adapter returns the same
   * `/static/<key>` (no expiry — public local files); S3 adapters generate
   * a pre-signed URL with `ttlSeconds` validity.
   */
  abstract getSignedUrl(key: string, ttlSeconds?: number): Promise<string>;
}
