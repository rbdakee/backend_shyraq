import { ConflictError } from '@/shared-kernel/domain/errors';

/**
 * Raised when the partial-unique index on (kindergarten_id, group_id, date) or
 * (kindergarten_id, date) WHERE group_id IS NULL is violated (PG code 23505).
 */
export class MealPlanAlreadyExistsError extends ConflictError {
  public readonly code = 'meal_plan_already_exists' as const;

  constructor(
    public readonly kindergartenId: string,
    public readonly date: string,
    public readonly groupId: string | null,
  ) {
    super(
      'meal_plan_already_exists',
      `A meal plan already exists for date ${date}${groupId ? ` / group ${groupId}` : ' (kg-wide)'}`,
    );
  }
}
