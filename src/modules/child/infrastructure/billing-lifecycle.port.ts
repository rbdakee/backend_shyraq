/**
 * BillingLifecyclePort — narrow port exposed by the billing module for the
 * child lifecycle service to invoke side-effects that live outside the
 * child aggregate. Today (B21 T3) the surface is one method: close every
 * active tariff_assignment for the archived child so the monthly cron
 * stops billing them.
 *
 * Why a port instead of a direct `TariffAssignmentRepository` injection:
 *   - `BillingModule` already imports `ChildModule` (for the
 *     `ChildGuardianRepository` re-export). A direct cross-module repo
 *     import in the other direction would close the cycle.
 *   - The port keeps the child module ignorant of the billing internals
 *     (tariff_assignment row schema) — billing is free to evolve the
 *     close semantics (e.g. add audit row, support reassignment) without
 *     leaking into the child service.
 *
 * Wiring: `ChildModule` registers a no-op default so service-unit fakes
 * keep compiling; `BillingModule` (or a small `@Global()` binding wrapper)
 * overrides with the real adapter that delegates to
 * `TariffAssignmentRepository.closeActiveForChild`.
 */
export abstract class BillingLifecyclePort {
  /**
   * Close every still-active tariff_assignment for `childId` at `validUntil`
   * (typically the archive moment). Returns the count of rows mutated so
   * the caller can log it. Default no-op when billing is not wired (tests,
   * stand-alone child-only bootstraps).
   */
  abstract closeActiveTariffAssignmentsForChild(
    kindergartenId: string,
    childId: string,
    validUntil: Date,
  ): Promise<{ closedCount: number }>;
}

/**
 * Default no-op adapter registered by `ChildModule`. Overridden in
 * production by the real billing-backed adapter wired in
 * `BillingLifecycleBridgeModule` (global).
 */
export class NoopBillingLifecycleAdapter extends BillingLifecyclePort {
  closeActiveTariffAssignmentsForChild(
    _kindergartenId: string,
    _childId: string,
    _validUntil: Date,
  ): Promise<{ closedCount: number }> {
    return Promise.resolve({ closedCount: 0 });
  }
}
