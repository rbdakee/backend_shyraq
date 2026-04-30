import { NotFoundError } from '@/shared-kernel/domain/errors';

export class MealItemNotFoundError extends NotFoundError {
  public readonly code = 'meal_item_not_found' as const;

  constructor(public readonly mealItemId: string) {
    super('meal_item', mealItemId);
  }
}
