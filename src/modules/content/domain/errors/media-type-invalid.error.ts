import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — `group_stories.media_type` is not one of the allowed values.
 * Mirrors the DB CHECK constraint `group_stories_media_type_check`
 * (`media_type IN ('image', 'video')`).
 *
 * Maps to BAD_REQUEST via DomainErrorFilter (InvariantViolationError → 400).
 */
export class MediaTypeInvalidError extends InvariantViolationError {
  public readonly details: { mediaType: string };

  constructor(mediaType: string) {
    super('media_type_invalid');
    this.details = { mediaType };
  }
}
