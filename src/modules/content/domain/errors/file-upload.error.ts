import { InvariantViolationError } from '@/shared-kernel/domain/errors';

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
 * The wire `code` is always `file_upload_failed`; the specific reason is in
 * `details.reason`.
 */
export class FileUploadError extends InvariantViolationError {
  public readonly details: {
    reason: FileUploadErrorReason;
    cause?: string;
  };

  constructor(reason: FileUploadErrorReason, cause?: string) {
    super('file_upload_failed');
    this.details = cause === undefined ? { reason } : { reason, cause };
  }
}
