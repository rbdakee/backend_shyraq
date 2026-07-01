import { DomainError } from '@/shared-kernel/domain/errors';

/**
 * 422 — timeline_entry `metadata` does not match the fixed shape for its
 * entry_type. Server-enforced contract (BR-013):
 *   - entry_type='mood' → if `metadata.mood` is present it must be one of
 *     `happy | ok | sad`.
 *   - entry_type='meal' → if `metadata.ate` is present it must be one of
 *     `all | half | little`.
 * `metadata` itself stays optional (validated only when the key is present);
 * extra keys are ignored; all other entry_types skip metadata validation.
 */
export class InvalidTimelineMetadataError extends DomainError {
  public readonly details: { entryType: string; reason: string };
  constructor(entryType: string, reason: string) {
    super(
      'invalid_timeline_metadata',
      `metadata invalid for entry_type '${entryType}': ${reason}`,
    );
    this.details = { entryType, reason };
  }
}
