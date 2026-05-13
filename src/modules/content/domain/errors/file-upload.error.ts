import {
  InvariantViolationError,
  NotFoundError,
  DomainError,
} from '@/shared-kernel/domain/errors';

/**
 * Subcodes for file upload / media-url validation failures.
 *
 * Reasons:
 *   - `media_url_required`  — the caller provided an empty or whitespace-only
 *                             `mediaUrl` for a content asset that requires one
 *                             (e.g. group_stories.media_url is NOT NULL).
 *   - `upload_failed`       — the underlying `FileStoragePort.put()` call
 *                             rejected (disk full, S3 5xx, network error).
 *                             The original cause is surfaced via
 *                             `details.cause` (a short string token, not the
 *                             raw error message — we don't leak provider
 *                             internals to clients).
 *   - `file_too_large`      — file exceeds the configured max-size limit
 *                             (Phase A: enforced at controller layer; this
 *                             reason exists so service-layer code paths can
 *                             surface a consistent error if needed).
 */
export type FileUploadErrorReason =
  | 'media_url_required'
  | 'upload_failed'
  | 'file_too_large';

/**
 * 400 — invalid or failed file upload. Maps to BAD_REQUEST via
 * DomainErrorFilter (InvariantViolationError → 400).
 *
 * The wire `code` is always `file_upload_error`; the specific reason is in
 * `details.reason`. (B17 T8 fix-pass: docs §2.10/§3.12 advertise
 * `file_upload_error` — the slug here is now the canonical code.)
 */
export class FileUploadError extends InvariantViolationError {
  public readonly details: {
    reason: FileUploadErrorReason;
    cause?: string;
  };

  constructor(reason: FileUploadErrorReason, cause?: string) {
    super('file_upload_error');
    this.details = cause === undefined ? { reason } : { reason, cause };
  }
}

/**
 * B22b T9 — discriminated storage error variants.
 *
 * Callers can distinguish error classes instead of inspecting `details.cause`
 * strings, enabling targeted retry policies:
 *
 *   - `FileStorageMalformedKeyError` (400)  — key is structurally invalid
 *     (empty, path-traversal attempt, percent-decode failure).  Never retry.
 *   - `FileStorageNotFoundError`    (404)  — key does not exist in the store
 *     (ENOENT on local disk, 404/NoSuchKey on S3).  Never retry.
 *   - `FileStorageTransientError`   (503)  — infrastructure failure that may
 *     be temporary (disk-full ENOSPC, S3 5xx, network error). Safe to retry.
 *
 * All three extend `DomainError` directly; `DomainErrorFilter` maps them
 * explicitly so callers get the right HTTP status.
 */
export class FileStorageMalformedKeyError extends DomainError {
  constructor(cause?: string) {
    super('file_storage_malformed_key', cause ?? 'file_storage_malformed_key');
  }
}

export class FileStorageNotFoundError extends NotFoundError {
  constructor(key: string) {
    super('file', key);
    // Override the code so DomainErrorFilter sees 'file_not_found'.
    Object.defineProperty(this, 'code', { value: 'file_not_found' });
  }
}

export class FileStorageTransientError extends DomainError {
  public readonly details: { cause: string };

  constructor(cause: string) {
    super('file_storage_transient_error', cause);
    this.details = { cause };
  }
}
