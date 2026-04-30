import { ForbiddenActionError } from '@/shared-kernel/domain/errors';

/**
 * 403 — non-admin caller tried to edit/delete a timeline_entries row they
 * did not author. T4's TimelineService.editEntry/deleteEntry checks
 * `entry.recordedBy === callerStaffId` and throws this on mismatch.
 */
export class TimelineEntryNotAuthorError extends ForbiddenActionError {
  constructor(public readonly entryId: string) {
    super(
      'timeline_entry_not_author',
      `caller is not the author of timeline_entry ${entryId}`,
    );
  }
}
