import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * 409 — caller tried to create or update a tariff_plan whose
 * `valid_from..valid_until` window overlaps with an existing active plan
 * targeting the same `(kindergarten_id, applies_to, group_id, tariff_type)`
 * tuple. Overlapping plans would cause `findActiveByType` / per-child resolution
 * to silently pick whichever row has the most recent `valid_from`, which is
 * brittle — the service rejects ambiguous catalogue state at write time.
 *
 * `appliesTo` granularity:
 *   - `all_children` — collision is per `(kg, tariff_type)`
 *   - `group`        — collision is per `(kg, tariff_type, group_id)`
 *   - `age_range`    — collision is per `(kg, tariff_type, age_range overlap)` —
 *                      conservative: any other `age_range` row of the same type
 *                      with a window overlap is treated as a conflict
 *   - `individual`   — never throws (assignments are per-child via
 *                      `tariff_assignments`, not per-plan)
 */
export class TariffPlanOverlapError extends ConflictError {
  public readonly code = 'tariff_plan_overlap' as const;

  constructor(tariffType: string, appliesTo: string, groupId: string | null) {
    super(
      'tariff_plan_overlap',
      `tariff plan overlap for tariff_type=${tariffType} applies_to=${appliesTo}${
        groupId ? ` group_id=${groupId}` : ''
      }`,
    );
  }
}
