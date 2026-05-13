import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { TransactionRunnerPort } from '@/shared-kernel/application/ports/transaction-runner.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { tenantStorage } from '@/database/tenant-storage';
import {
  DiscountRules,
  TariffAppliesTo,
  TariffPlan,
  TariffPlanState,
  TariffType,
} from './domain/entities/tariff-plan.entity';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import { TariffPlanOverlapError } from './domain/errors/tariff-plan-overlap.error';
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
 * Overlap protection (B22b T6 + B22b T15 Codex H2): `create` and `update`
 * reject any catalogue state where two **active** plans targeting the same
 * `(kg, applies_to, group_id, tariff_type)` tuple have overlapping
 * `valid_from..valid_until` windows. The check is race-safe via
 * `pg_advisory_xact_lock(hashtext('tariff-overlap:'||kg||':'||type||':'||
 * appliesTo||':'||groupId/null))` acquired BEFORE `existsOverlap()` inside
 * an ambient TX — without the lock, two concurrent admin clicks for the
 * same scope could both observe `existsOverlap=false` and both insert,
 * leaving `findActiveByType` to silently pick whichever row has the
 * latest `valid_from`. Admins must close (`deactivate`) the existing
 * plan before issuing a new one for the same scope, OR pick a non-overlapping
 * effective window. `individual` plans are exempt — per-child rules are
 * managed via `tariff_assignments`.
 */
@Injectable()
export class TariffPlanService {
  constructor(
    private readonly tariffPlans: TariffPlanRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
    @Inject(TransactionRunnerPort)
    private readonly tx: TransactionRunnerPort,
  ) {}

  async create(
    kindergartenId: string,
    input: CreateTariffPlanInput,
  ): Promise<TariffPlan> {
    const now = this.clock.now();
    const groupId = input.groupId ?? null;
    const validUntil = input.validUntil ?? null;

    return this.tx.run(async (em) => {
      // Re-publish the kg-scoped GUC + tenantStorage so the repo methods
      // running INSIDE this TX see the same EM (RLS + advisory lock both
      // hang off the open TX). Mirror of the pattern in
      // `custom-discount.service.ts.activate`.
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      return tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        async () => {
          // T15 H2 — serialise concurrent creators for the same scope.
          // Releases at TX commit/rollback.
          await this.tariffPlans.acquireOverlapAdvisoryLock(
            kindergartenId,
            input.tariffType,
            input.appliesTo,
            groupId,
            em,
          );

          // Overlap guard — rejects ambiguous catalogue state at write time.
          const overlaps = await this.tariffPlans.existsOverlap(
            kindergartenId,
            input.tariffType,
            input.appliesTo,
            groupId,
            input.validFrom,
            validUntil,
          );
          if (overlaps) {
            throw new TariffPlanOverlapError(
              input.tariffType,
              input.appliesTo,
              groupId,
            );
          }

          const state: TariffPlanState = {
            id: randomUUID(),
            kindergartenId,
            name: input.name,
            description: input.description ?? {},
            tariffType: input.tariffType,
            amount: MoneyKzt.fromKzt(input.amount),
            currency: input.currency ?? 'KZT',
            appliesTo: input.appliesTo,
            groupId,
            ageMinMonths: input.ageMinMonths ?? null,
            ageMaxMonths: input.ageMaxMonths ?? null,
            isActive: true,
            validFrom: input.validFrom,
            validUntil,
            discountRules: input.discountRules ?? {},
            createdAt: now,
            updatedAt: now,
          };
          const plan = TariffPlan.fromState(state);
          return this.tariffPlans.create(plan);
        },
      );
    });
  }

  async update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffPlanInput,
  ): Promise<TariffPlan> {
    const now = this.clock.now();

    // Re-check the overlap guard only if the caller is changing fields that
    // affect window/scoping. The `tariff_type` and `applies_to` columns are
    // immutable on update (catalogue-level change requires deactivate+create
    // per docs/endpoints.md §2.13), so we only react to validFrom/validUntil
    // (group_id is also immutable per the DTO surface).
    const needsOverlapCheck =
      patch.validFrom !== undefined || patch.validUntil !== undefined;

    if (!needsOverlapCheck) {
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

    return this.tx.run(async (em) => {
      await em.query(`SELECT set_config('app.kindergarten_id', $1, true)`, [
        kindergartenId,
      ]);
      return tenantStorage.run(
        { kgId: kindergartenId, bypass: false, entityManager: em },
        async () => {
          const existing = await this.tariffPlans.findById(kindergartenId, id);
          if (!existing) {
            throw new TariffPlanNotFoundError(id);
          }
          // T15 H2 — acquire the same scope-keyed lock as create() so a
          // concurrent create() and update() for the same scope are also
          // serialised (the scope key is invariant: tariff_type / applies_to
          // / group_id are immutable on update per endpoints.md §2.13).
          await this.tariffPlans.acquireOverlapAdvisoryLock(
            kindergartenId,
            existing.tariffType,
            existing.appliesTo,
            existing.groupId,
            em,
          );

          const newFrom = patch.validFrom ?? existing.validFrom;
          const newUntil =
            patch.validUntil !== undefined
              ? patch.validUntil
              : existing.validUntil;
          const overlaps = await this.tariffPlans.existsOverlap(
            kindergartenId,
            existing.tariffType,
            existing.appliesTo,
            existing.groupId,
            newFrom,
            newUntil,
            id,
          );
          if (overlaps) {
            throw new TariffPlanOverlapError(
              existing.tariffType,
              existing.appliesTo,
              existing.groupId,
            );
          }

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
        },
      );
    });
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
