import {
  MealItem,
  MealItemState,
  MultiLangText,
} from '../../../../domain/entities/meal-item.entity';
import {
  MealPlan,
  MealPlanSource,
  MealPlanState,
} from '../../../../domain/entities/meal-plan.entity';
import { MealItemEntity } from '../entities/meal-item.entity';
import { MealPlanEntity } from '../entities/meal-plan.entity';

export class MealPlanMapper {
  static toDomain(row: MealPlanEntity): MealPlan {
    const state: MealPlanState = {
      id: row.id,
      kindergartenId: row.kindergarten_id,
      date: row.date,
      groupId: row.group_id,
      isPublished: row.is_published,
      notes: row.notes as MultiLangText | null,
      source: row.source as MealPlanSource,
      copiedFrom: row.copied_from,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      items: (row.items ?? []).map(MealPlanMapper.itemToDomain),
    };
    return MealPlan.hydrate(state);
  }

  static itemToDomain(row: MealItemEntity): MealItemState {
    return {
      id: row.id,
      mealPlanId: row.meal_plan_id,
      mealType: row.meal_type as MealItem['mealType'],
      dishName: row.dish_name as MultiLangText,
      description: row.description as MultiLangText | null,
      allergens: row.allergens,
      photoUrl: row.photo_url,
      calories: row.calories,
      serveTime: row.serve_time,
      position: row.position,
    };
  }

  static toOrmPartial(plan: MealPlan): Partial<MealPlanEntity> {
    const state = plan.toState();
    return {
      id: state.id,
      kindergarten_id: state.kindergartenId,
      date: state.date,
      group_id: state.groupId,
      is_published: state.isPublished,
      notes: state.notes as object | null,
      source: state.source,
      copied_from: state.copiedFrom,
      created_by: state.createdBy,
    };
  }

  static itemToOrm(item: MealItemState): Partial<MealItemEntity> {
    return {
      id: item.id,
      meal_plan_id: item.mealPlanId,
      meal_type: item.mealType,
      dish_name: item.dishName as object,
      description: item.description as object | null,
      allergens: item.allergens,
      photo_url: item.photoUrl,
      calories: item.calories,
      serve_time: item.serveTime,
      position: item.position,
    };
  }
}
