import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * Subcodes for ContentPost target-shape violations. The wire `code` is always
 * `content_target_invalid`; the precise reason is surfaced via `details.reason`.
 *
 * Reasons:
 *   - `target_ids_must_be_empty`    — `targetType='all'` but `targetGroupId`
 *                                     and/or `targetChildId` is non-null.
 *   - `target_group_id_required`    — `targetType='group'` but
 *                                     `targetGroupId` is null.
 *   - `target_child_id_required`    — `targetType='child'` but
 *                                     `targetChildId` is null.
 *   - `target_ids_mutually_exclusive` — `targetType='group'` with
 *                                       `targetChildId` non-null OR
 *                                       `targetType='child'` with
 *                                       `targetGroupId` non-null.
 *   - `unknown_target_type`         — `targetType` is not one of
 *                                     `'all'|'group'|'child'`.
 */
export type ContentTargetInvalidReason =
  | 'target_ids_must_be_empty'
  | 'target_group_id_required'
  | 'target_child_id_required'
  | 'target_ids_mutually_exclusive'
  | 'unknown_target_type';

/**
 * 400 — invalid target shape on a content_posts row, mirrors the DB
 * `content_posts_target_invariant_check` constraint:
 *   - target_type='all'   → target_group_id IS NULL AND target_child_id IS NULL
 *   - target_type='group' → target_group_id IS NOT NULL AND target_child_id IS NULL
 *   - target_type='child' → target_child_id IS NOT NULL AND target_group_id IS NULL
 *
 * Maps to BAD_REQUEST via DomainErrorFilter (InvariantViolationError → 400).
 */
export class ContentTargetInvalidError extends InvariantViolationError {
  public readonly details: {
    targetType: string;
    reason: ContentTargetInvalidReason;
  };

  constructor(targetType: string, reason: ContentTargetInvalidReason) {
    super('content_target_invalid');
    this.details = { targetType, reason };
  }
}
