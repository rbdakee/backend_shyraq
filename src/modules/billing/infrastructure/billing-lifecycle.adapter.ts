import { Injectable } from '@nestjs/common';
import { BillingLifecyclePort } from '@/modules/child/infrastructure/billing-lifecycle.port';
import { TariffAssignmentRepository } from '../infrastructure/persistence/tariff-assignment.repository';
import { InvoiceRepository } from '../infrastructure/persistence/invoice.repository';

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
  constructor(
    private readonly tariffAssignments: TariffAssignmentRepository,
    private readonly invoices: InvoiceRepository,
  ) {
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

  /**
   * Delegates to `InvoiceRepository.getOutstandingByChild` — the admin
   * children-list overlay. Kept a single batch query so listing N children
   * costs one round-trip regardless of N.
   */
  async getOutstandingForChildren(
    kindergartenId: string,
    childIds: string[],
  ): Promise<Map<string, number>> {
    return this.invoices.getOutstandingByChild(kindergartenId, childIds);
  }
}
