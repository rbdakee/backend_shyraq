import { NotFoundError } from '@/shared-kernel/domain/errors';

export class MealPlanNotFoundError extends NotFoundError {
  public readonly code = 'meal_plan_not_found' as const;

  constructor(public readonly mealPlanId: string) {
    super('meal_plan', mealPlanId);
  }
}
