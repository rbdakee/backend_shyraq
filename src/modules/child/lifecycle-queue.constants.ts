/**
 * BullMQ queue + job names for child lifecycle side-effects (B21 T3).
 *
 * Producer: `ChildService.archive` enqueues `lifecycle:pro-rata-refund`
 * after the conditional UPDATE commits.
 * Consumer: `ProRataRefundProcessor` (lives in `BillingModule`) computes
 * the pro-rata refund row for the archived child in its current billing
 * period.
 *
 * Other lifecycle side-effects (e.g. notifying mentors, archiving meal
 * plan attendees) will land on the same queue with distinct job names to
 * keep the wiring single-queue per cross-module signal.
 */
export const LIFECYCLE_QUEUE = 'lifecycle';
export const LIFECYCLE_PRO_RATA_REFUND_JOB = 'lifecycle:pro-rata-refund';

export interface ProRataRefundJobData {
  kindergartenId: string;
  childId: string;
  /** ISO timestamp of the archive transition. */
  archivedAt: string;
}
