import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * Subcodes for ContentPost state-machine violations. The wire `code` is
 * always `content_post_status_invalid`; the more specific reason is surfaced
 * via `details.reason` so clients can render targeted UX messages.
 *
 * Reasons:
 *   - `wrong_source_status`         — generic state-machine guard (e.g. publishing
 *                                     an already-published post, deleting a
 *                                     scheduled post, scheduling from published).
 *   - `content_scheduled_for_in_past` — `schedule()` called with a `scheduledFor`
 *                                       that is not strictly in the future.
 *   - `content_type_immutable`        — `update()` attempted to mutate
 *                                       `contentType`, which is fixed at
 *                                       creation.
 *   - `content_already_published`     — `update()` / `schedule()` called on a
 *                                       post in `published` (terminal) status.
 *   - `content_cannot_delete_published` — caller asked to delete a non-draft
 *                                         post; only draft is deletable.
 */
export type ContentPostStatusInvalidReason =
  | 'wrong_source_status'
  | 'content_scheduled_for_in_past'
  | 'content_type_immutable'
  | 'content_already_published'
  | 'content_cannot_delete_published';

/**
 * 409 — state-machine guard violation: the caller asked the ContentPost
 * aggregate to perform a transition (`schedule`, `publish`, `update`,
 * `delete`) that is not legal from its current status, or attempted to
 * mutate an immutable field.
 *
 * `currentStatus` / `attemptedTransition` give clients enough context to
 * render an actionable message; `reason` narrows the cause.
 */
export class ContentPostStatusInvalidError extends ConflictError {
  public readonly code = 'content_post_status_invalid' as const;
  public readonly details: {
    currentStatus: string;
    attemptedTransition: string;
    reason: ContentPostStatusInvalidReason;
  };

  constructor(
    currentStatus: string,
    attemptedTransition: string,
    reason: ContentPostStatusInvalidReason = 'wrong_source_status',
  ) {
    super(
      'content_post_status_invalid',
      `content post status invalid: transition=${attemptedTransition} got=${currentStatus} reason=${reason}`,
    );
    this.details = { currentStatus, attemptedTransition, reason };
  }
}
