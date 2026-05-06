import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — caller tried to assign or invoice against a tariff plan that has
 * been deactivated (`is_active=false`). Only active plans can be the basis
 * of new assignments or generated invoices.
 */
export class TariffPlanInactiveError extends ConflictError {
  public readonly code = 'tariff_plan_inactive' as const;

  constructor(tariffPlanId: string) {
    super('tariff_plan_inactive', `tariff plan inactive: ${tariffPlanId}`);
  }
}
