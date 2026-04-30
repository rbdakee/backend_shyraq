import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChildModule } from '@/modules/child/child.module';
import { GroupModule } from '@/modules/group/group.module';
import { MealItemEntity } from './infrastructure/persistence/relational/entities/meal-item.entity';
import { MealPlanEntity } from './infrastructure/persistence/relational/entities/meal-plan.entity';
import { MealPlanRelationalRepository } from './infrastructure/persistence/relational/repositories/meal-plan-relational.repository';
import { MealPlanRepository } from './infrastructure/persistence/meal-plan.repository';
import { MealAdminController } from './meal.admin.controller';
import { MealParentController } from './meal.parent.controller';
import { MealService } from './meal.service';
import { MealStaffController } from './meal.staff.controller';

/**
 * MealModule — wires meal_plans + meal_items aggregate (B7).
 *
 * - Imports ChildModule (forwardRef to avoid circular) for getMenuForChild.
 * - Imports GroupModule for group validation on createPlan.
 * - Exports MealService so T5 cron can call copyWeekMenuToNext.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MealPlanEntity, MealItemEntity]),
    forwardRef(() => ChildModule),
    GroupModule,
  ],
  controllers: [MealAdminController, MealStaffController, MealParentController],
  providers: [
    MealService,
    {
      provide: MealPlanRepository,
      useClass: MealPlanRelationalRepository,
    },
  ],
  exports: [MealService],
})
export class MealModule {}
