import { NotFoundError } from '@/shared-kernel/domain/errors';

/**
 * 404 — caller asked for a tariff_plan id that is not visible under the
 * caller's tenant scope (or simply does not exist).
 */
export class TariffPlanNotFoundError extends NotFoundError {
  public readonly code = 'tariff_plan_not_found' as const;

  constructor(tariffPlanId: string) {
    super('tariff_plan', tariffPlanId);
  }
}
