import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  DiscountRules,
  TariffAppliesTo,
  TariffPlan,
  TariffPlanState,
  TariffType,
} from './domain/entities/tariff-plan.entity';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import {
  ListTariffPlansFilter,
  TariffPlanRepository,
  UpdateTariffPlanPatch,
} from './infrastructure/persistence/tariff-plan.repository';

export interface CreateTariffPlanInput {
  name: string;
  description?: Record<string, string>;
  tariffType: TariffType;
  amount: number;
  currency?: string;
  appliesTo: TariffAppliesTo;
  groupId?: string | null;
  ageMinMonths?: number | null;
  ageMaxMonths?: number | null;
  validFrom: Date;
  validUntil?: Date | null;
  discountRules?: DiscountRules;
}

export type UpdateTariffPlanInput = UpdateTariffPlanPatch;

/**
 * TariffPlanService — admin-side CRUD over the per-kindergarten tariff
 * catalogue. Tenant-scoped via the ambient HTTP TX (`KindergartenScopeGuard`
 * + `TenantContextInterceptor`). Service-layer rules apply (CLAUDE.md §8) —
 * no `Repository<X>` / `DataSource` imports; everything goes through the
 * injected port.
 *
 * TODO(B13 review): non-overlapping `valid_from..valid_until` per
 * (kg_id, applies_to, group_id?, tariff_type) — defer to T9 review pass.
 * Practical impact today is low (admin must explicitly create overlapping
 * plans and invoice generation picks the most recent `valid_from`).
 */
@Injectable()
export class TariffPlanService {
  constructor(
    private readonly tariffPlans: TariffPlanRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async create(
    kindergartenId: string,
    input: CreateTariffPlanInput,
  ): Promise<TariffPlan> {
    const now = this.clock.now();
    const state: TariffPlanState = {
      id: randomUUID(),
      kindergartenId,
      name: input.name,
      description: input.description ?? {},
      tariffType: input.tariffType,
      amount: input.amount,
      currency: input.currency ?? 'KZT',
      appliesTo: input.appliesTo,
      groupId: input.groupId ?? null,
      ageMinMonths: input.ageMinMonths ?? null,
      ageMaxMonths: input.ageMaxMonths ?? null,
      isActive: true,
      validFrom: input.validFrom,
      validUntil: input.validUntil ?? null,
      discountRules: input.discountRules ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const plan = TariffPlan.fromState(state);
    return this.tariffPlans.create(plan);
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffPlanInput,
  ): Promise<TariffPlan> {
    const now = this.clock.now();
    const updated = await this.tariffPlans.update(
      kindergartenId,
      id,
      patch,
      now,
    );
    if (!updated) {
      throw new TariffPlanNotFoundError(id);
    }
    return updated;
  }

  async deactivate(kindergartenId: string, id: string): Promise<TariffPlan> {
    const plan = await this.tariffPlans.findById(kindergartenId, id);
    if (!plan) {
      throw new TariffPlanNotFoundError(id);
    }
    plan.deactivate(this.clock.now());
    return this.tariffPlans.save(plan);
  }

  async list(
    kindergartenId: string,
    filter?: ListTariffPlansFilter,
  ): Promise<TariffPlan[]> {
    return this.tariffPlans.list(kindergartenId, filter);
  }

  async get(kindergartenId: string, id: string): Promise<TariffPlan> {
    const plan = await this.tariffPlans.findById(kindergartenId, id);
    if (!plan) {
      throw new TariffPlanNotFoundError(id);
    }
    return plan;
  }
}
