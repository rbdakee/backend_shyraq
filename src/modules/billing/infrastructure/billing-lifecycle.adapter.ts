import { Injectable } from '@nestjs/common';
import { BillingLifecyclePort } from '@/modules/child/infrastructure/billing-lifecycle.port';
import { TariffAssignmentRepository } from '../infrastructure/persistence/tariff-assignment.repository';

/**
 * BillingLifecycleAdapter — production binding for `BillingLifecyclePort`.
 *
 * Delegates to `TariffAssignmentRepository.closeActiveForChild` so the
 * archive flow in `ChildService.archive` closes every open tariff
 * assignment for the child at the archive moment. The repo method is
 * idempotent under the archive flow (clamping NULL/future valid_until
 * down to `$validUntil`) so a replay after a partial failure is safe.
 *
 * Wired by `BillingLifecycleBridgeModule` (global) so child-module
 * resolution sees the production binding instead of the
 * `NoopBillingLifecycleAdapter` default registered inside `ChildModule`.
 */
@Injectable()
export class BillingLifecycleAdapter extends BillingLifecyclePort {
  constructor(private readonly tariffAssignments: TariffAssignmentRepository) {
    super();
  }

  async closeActiveTariffAssignmentsForChild(
    kindergartenId: string,
    childId: string,
    validUntil: Date,
  ): Promise<{ closedCount: number }> {
    return this.tariffAssignments.closeActiveForChild(
      kindergartenId,
      childId,
      validUntil,
    );
  }

  /**
   * Delegates to `findActiveForChild` — non-null means the child has a
   * tariff_assignment covering `atDate`. Drives the
   * `ChildService.activateChild` precondition (a child may only go
   * `card_created → active` once it is billable).
   */
  async hasActiveTariffAssignmentForChild(
    kindergartenId: string,
    childId: string,
    atDate: Date,
  ): Promise<boolean> {
    const assignment = await this.tariffAssignments.findActiveForChild(
      kindergartenId,
      childId,
      atDate,
    );
    return assignment !== null;
  }
}
