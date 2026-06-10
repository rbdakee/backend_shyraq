import { ConflictError } from '@/shared-kernel/domain/errors/conflict.error';

/**
 * Activation attempt (`card_created → active`) against a child that has no
 * active `tariff_assignment` covering the activation moment.
 *
 * Enforced by `ChildService.activateChild` via `BillingLifecyclePort
 * .hasActiveTariffAssignmentForChild`. An `active` child must be billable —
 * the monthly billing cron keys on `tariff_assignments`, so activating a
 * child with no assignment would create a permanently-uninvoiced "free"
 * active row. The admin must assign a tariff
 * (`POST /admin/tariff-assignments`) before activating.
 *
 * Mapped to HTTP 409 — same precondition family as
 * `child_already_archived` / `child_not_archived`; the UI should surface the
 * "assign a tariff first" next step.
 */
export class ChildActivationRequiresTariffError extends ConflictError {
  constructor(public readonly childId: string) {
    super(
      'child_activation_requires_tariff',
      `child ${childId} cannot be activated without an active tariff assignment`,
    );
  }
}
