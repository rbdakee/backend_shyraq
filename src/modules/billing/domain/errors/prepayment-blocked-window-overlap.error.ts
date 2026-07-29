import { InvariantViolationError } from '@/shared-kernel/domain/errors';

/**
 * 400 — after the §2.3 window shift, a month INSIDE the requested window is
 * still covered by a paid prepayment (non-contiguous coverage, e.g. a
 * refunded middle window leaving covered months on both sides). Silently
 * billing an already-covered month would double-charge the parent (review
 * FIX 9), so the quote/create is blocked instead; `covered_months` lists
 * the overlapping `YYYY-MM` keys. The spec §2.3 "shift start only" rule is
 * preserved for the normal contiguous case — this error fires only on the
 * non-contiguous edge.
 */
export class PrepaymentBlockedWindowOverlapError extends InvariantViolationError {
  public readonly details: { covered_months: string[] };

  constructor(coveredMonths: string[]) {
    super('prepayment_blocked_window_overlap');
    this.details = { covered_months: coveredMonths };
  }
}
