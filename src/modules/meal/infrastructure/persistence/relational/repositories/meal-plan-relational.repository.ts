import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { QueryFailedError } from 'typeorm';
import { tenantStorage } from '@/database/tenant-storage';
import { MealPlan } from '../../../../domain/entities/meal-plan.entity';
import { MealPlanAlreadyExistsError } from '../../../../domain/errors/meal-plan-already-exists.error';
import {
  ListMealPlansFilter,
  MealPlanRepository,
} from '../../meal-plan.repository';
import { MealItemEntity } from '../entities/meal-item.entity';
import { MealPlanEntity } from '../entities/meal-plan.entity';
import { MealPlanMapper } from '../mappers/meal-plan.mapper';
import { MealItemState } from '../../../../domain/entities/meal-item.entity';

interface PgError {
  code?: string;
  constraint?: string;
}

function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const pg = (err as QueryFailedError).driverError as PgError;
  return pg.code === '23505';
}

@Injectable()
export class MealPlanRelationalRepository extends MealPlanRepository {
  constructor(
    @InjectRepository(MealPlanEntity)
    private readonly repo: Repository<MealPlanEntity>,
    @InjectRepository(MealItemEntity)
    private readonly itemRepo: Repository<MealItemEntity>,
  ) {
    super();
  }

  private manager(): EntityManager {
    const ctx = tenantStorage.getStore();
    return ctx?.entityManager ?? this.repo.manager;
  }

  async create(kindergartenId: string, plan: MealPlan): Promise<MealPlan> {
    try {
      const m = this.manager();
      const planRepo = m.getRepository(MealPlanEntity);
      const itemRepo = m.getRepository(MealItemEntity);
      const state = plan.toState();

      await planRepo.insert({
        id: state.id,
        kindergarten_id: state.kindergartenId,
        date: state.date,
        group_id: state.groupId,
        is_published: state.isPublished,
        notes: state.notes as object | null,
        source: state.source,
        copied_from: state.copiedFrom,
        created_by: state.createdBy,
        created_at: state.createdAt,
        updated_at: state.updatedAt,
      });

      if (state.items.length > 0) {
        await itemRepo.insert(state.items.map((i) => this.itemToInsert(i)));
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new MealPlanAlreadyExistsError(
          kindergartenId,
          plan.date,
          plan.groupId,
        );
      }
      throw err;
    }

    return this.findByIdOrThrow(kindergartenId, plan.id);
  }

  async findById(
    kindergartenId: string,
    planId: string,
  ): Promise<MealPlan | null> {
    const row = await this.manager()
      .getRepository(MealPlanEntity)
      .findOne({
        where: { id: planId, kindergarten_id: kindergartenId },
        relations: ['items'],
      });
    return row ? MealPlanMapper.toDomain(row) : null;
  }

  async list(
    kindergartenId: string,
    filter: ListMealPlansFilter,
  ): Promise<MealPlan[]> {
    const qb = this.manager()
      .getRepository(MealPlanEntity)
      .createQueryBuilder('mp')
      .leftJoinAndSelect('mp.items', 'mi')
      .where('mp.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('mp.date >= :from', { from: filter.dateFrom })
      .andWhere('mp.date <= :to', { to: filter.dateTo });

    if (filter.groupId !== undefined) {
      if (filter.groupId === null) {
        qb.andWhere('mp.group_id IS NULL');
      } else {
        qb.andWhere('mp.group_id = :groupId', { groupId: filter.groupId });
      }
    }

    qb.orderBy('mp.date', 'ASC').addOrderBy('mi.position', 'ASC');

    const rows = await qb.getMany();
    return rows.map(MealPlanMapper.toDomain);
  }

  async update(kindergartenId: string, plan: MealPlan): Promise<MealPlan> {
    const state = plan.toState();
    await this.manager()
      .getRepository(MealPlanEntity)
      .update(
        { id: state.id, kindergarten_id: kindergartenId },
        {
          is_published: state.isPublished,
          notes: state.notes as object | null,
          updated_at: state.updatedAt,
        },
      );
    return this.findByIdOrThrow(kindergartenId, plan.id);
  }

  async delete(kindergartenId: string, planId: string): Promise<void> {
    await this.manager()
      .getRepository(MealPlanEntity)
      .delete({ id: planId, kindergarten_id: kindergartenId });
  }

  async addItem(planId: string, plan: MealPlan): Promise<MealPlan> {
    const state = plan.toState();
    const newItem = state.items[state.items.length - 1];
    await this.manager()
      .getRepository(MealItemEntity)
      .insert(this.itemToInsert(newItem));
    return this.findByIdOrThrow(plan.kindergartenId, planId);
  }

  async updateItem(planId: string, plan: MealPlan): Promise<MealPlan> {
    const state = plan.toState();
    for (const item of state.items) {
      await this.manager()
        .getRepository(MealItemEntity)
        .update(
          { id: item.id, meal_plan_id: planId },
          {
            meal_type: item.mealType,
            dish_name: item.dishName as object,
            description: item.description as object | null,
            allergens: item.allergens,
            photo_url: item.photoUrl,
            calories: item.calories,
            position: item.position,
          },
        );
    }
    return this.findByIdOrThrow(plan.kindergartenId, planId);
  }

  async removeItem(
    planId: string,
    itemId: string,
    plan: MealPlan,
  ): Promise<MealPlan> {
    await this.manager()
      .getRepository(MealItemEntity)
      .delete({ id: itemId, meal_plan_id: planId });
    return this.findByIdOrThrow(plan.kindergartenId, planId);
  }

  async listForWeek(
    kindergartenId: string,
    weekStart: string,
    groupId: string | null,
  ): Promise<MealPlan[]> {
    const start = new Date(weekStart);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const dateTo = end.toISOString().slice(0, 10);

    const qb = this.manager()
      .getRepository(MealPlanEntity)
      .createQueryBuilder('mp')
      .leftJoinAndSelect('mp.items', 'mi')
      .where('mp.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('mp.is_published = true')
      .andWhere('mp.date >= :from', { from: weekStart })
      .andWhere('mp.date <= :to', { to: dateTo });

    if (groupId !== null) {
      qb.andWhere('(mp.group_id = :gid OR mp.group_id IS NULL)', {
        gid: groupId,
      });
    } else {
      qb.andWhere('mp.group_id IS NULL');
    }

    qb.orderBy('mp.date', 'ASC').addOrderBy('mi.position', 'ASC');
    const rows = await qb.getMany();
    return rows.map(MealPlanMapper.toDomain);
  }

  async existsAnyInRange(
    kindergartenId: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<boolean> {
    const count = await this.manager()
      .getRepository(MealPlanEntity)
      .createQueryBuilder('mp')
      .where('mp.kindergarten_id = :kg', { kg: kindergartenId })
      .andWhere('mp.date >= :from', { from: dateFrom })
      .andWhere('mp.date <= :to', { to: dateTo })
      .getCount();
    return count > 0;
  }

  async batchCreate(
    kindergartenId: string,
    plans: MealPlan[],
  ): Promise<{ plans_created: number; plans_skipped: number }> {
    let plans_created = 0;
    let plans_skipped = 0;

    for (const plan of plans) {
      try {
        const m = this.manager();
        const planRepo = m.getRepository(MealPlanEntity);
        const itemRepo = m.getRepository(MealItemEntity);
        const state = plan.toState();

        await planRepo.insert({
          id: state.id,
          kindergarten_id: state.kindergartenId,
          date: state.date,
          group_id: state.groupId,
          is_published: state.isPublished,
          notes: state.notes as object | null,
          source: state.source,
          copied_from: state.copiedFrom,
          created_by: state.createdBy,
          created_at: state.createdAt,
          updated_at: state.updatedAt,
        });

        if (state.items.length > 0) {
          await itemRepo.insert(state.items.map((i) => this.itemToInsert(i)));
        }
        plans_created++;
      } catch (err) {
        if (isUniqueViolation(err)) {
          plans_skipped++;
        } else {
          throw err;
        }
      }
    }
    return { plans_created, plans_skipped };
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private itemToInsert(item: MealItemState) {
    return {
      id: item.id,
      meal_plan_id: item.mealPlanId,
      meal_type: item.mealType,
      dish_name: item.dishName as object,
      description: item.description as object | null,
      allergens: item.allergens,
      photo_url: item.photoUrl,
      calories: item.calories,
      position: item.position,
    };
  }

  private async findByIdOrThrow(
    kindergartenId: string,
    planId: string,
  ): Promise<MealPlan> {
    const row = await this.manager()
      .getRepository(MealPlanEntity)
      .findOne({
        where: { id: planId, kindergarten_id: kindergartenId },
        relations: ['items'],
      });
    if (!row) {
      throw new Error(`meal_plan_readback_failed:${planId}@${kindergartenId}`);
    }
    return MealPlanMapper.toDomain(row);
  }
}
