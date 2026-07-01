/**
 * POJO domain entity for a single dish within a MealPlan.
 * No TypeORM or NestJS imports allowed in this layer.
 */

export type MealTypeValue =
  | 'breakfast'
  | 'snack_am'
  | 'lunch'
  | 'snack_pm'
  | 'dinner';

export interface MultiLangText {
  ru: string;
  kk?: string;
  en?: string;
}

export interface MealItemState {
  id: string;
  mealPlanId: string;
  mealType: MealTypeValue;
  dishName: MultiLangText;
  description: MultiLangText | null;
  allergens: string[] | null;
  photoUrl: string | null;
  calories: number | null;
  serveTime: string | null;
  position: number;
}

export interface CreateMealItemInput {
  id: string;
  mealPlanId: string;
  mealType: MealTypeValue;
  dishName: MultiLangText;
  description?: MultiLangText | null;
  allergens?: string[] | null;
  photoUrl?: string | null;
  calories?: number | null;
  serveTime?: string | null;
  position?: number;
}

export interface UpdateMealItemPatch {
  mealType?: MealTypeValue;
  dishName?: MultiLangText;
  description?: MultiLangText | null;
  allergens?: string[] | null;
  photoUrl?: string | null;
  calories?: number | null;
  serveTime?: string | null;
  position?: number;
}

export class MealItem {
  readonly id: string;
  readonly mealPlanId: string;
  mealType: MealTypeValue;
  dishName: MultiLangText;
  description: MultiLangText | null;
  allergens: string[] | null;
  photoUrl: string | null;
  calories: number | null;
  serveTime: string | null;
  position: number;

  private constructor(state: MealItemState) {
    this.id = state.id;
    this.mealPlanId = state.mealPlanId;
    this.mealType = state.mealType;
    this.dishName = state.dishName;
    this.description = state.description;
    this.allergens = state.allergens;
    this.photoUrl = state.photoUrl;
    this.calories = state.calories;
    this.serveTime = state.serveTime;
    this.position = state.position;
  }

  static create(input: CreateMealItemInput): MealItem {
    return new MealItem({
      id: input.id,
      mealPlanId: input.mealPlanId,
      mealType: input.mealType,
      dishName: input.dishName,
      description: input.description ?? null,
      allergens: input.allergens ?? null,
      photoUrl: input.photoUrl ?? null,
      calories: input.calories ?? null,
      serveTime: input.serveTime ?? null,
      position: input.position ?? 0,
    });
  }

  static hydrate(state: MealItemState): MealItem {
    return new MealItem(state);
  }

  applyPatch(patch: UpdateMealItemPatch): void {
    if (patch.mealType !== undefined) this.mealType = patch.mealType;
    if (patch.dishName !== undefined) this.dishName = patch.dishName;
    if (patch.description !== undefined) this.description = patch.description;
    if (patch.allergens !== undefined) this.allergens = patch.allergens;
    if (patch.photoUrl !== undefined) this.photoUrl = patch.photoUrl;
    if (patch.calories !== undefined) this.calories = patch.calories;
    if (patch.serveTime !== undefined) this.serveTime = patch.serveTime;
    if (patch.position !== undefined) this.position = patch.position;
  }

  toState(): MealItemState {
    return {
      id: this.id,
      mealPlanId: this.mealPlanId,
      mealType: this.mealType,
      dishName: this.dishName,
      description: this.description,
      allergens: this.allergens,
      photoUrl: this.photoUrl,
      calories: this.calories,
      serveTime: this.serveTime,
      position: this.position,
    };
  }
}
