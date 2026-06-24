import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { MealPlanEntity } from './meal-plan.entity';

@Entity({ name: 'meal_items' })
export class MealItemEntity {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'meal_plan_id', type: 'uuid' })
  meal_plan_id: string;

  @ManyToOne(() => MealPlanEntity, (plan) => plan.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'meal_plan_id', referencedColumnName: 'id' })
  mealPlan?: MealPlanEntity;

  @Column({
    name: 'meal_type',
    type: 'enum',
    enum: ['breakfast', 'snack_am', 'lunch', 'snack_pm', 'dinner'],
  })
  meal_type: string;

  @Column({ name: 'dish_name', type: 'jsonb' })
  dish_name: object;

  @Column({ type: 'jsonb', nullable: true })
  description: object | null;

  @Column({ type: 'text', array: true, nullable: true })
  allergens: string[] | null;

  @Column({ name: 'photo_url', type: 'text', nullable: true })
  photo_url: string | null;

  @Column({ type: 'int', nullable: true })
  calories: number | null;

  @Column({ name: 'serve_time', type: 'text', nullable: true })
  serve_time: string | null;

  @Column({ type: 'int', default: 0 })
  position: number;
}
