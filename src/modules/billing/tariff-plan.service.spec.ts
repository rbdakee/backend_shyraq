import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import {
  TariffPlan,
  TariffPlanState,
} from './domain/entities/tariff-plan.entity';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import {
  ListTariffPlansFilter,
  TariffPlanRepository,
  UpdateTariffPlanPatch,
} from './infrastructure/persistence/tariff-plan.repository';
import { TariffPlanService } from './tariff-plan.service';
import { TariffType } from './domain/entities/tariff-plan.entity';

const KG = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-05-04T09:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

function basePlanState(
  overrides: Partial<TariffPlanState> = {},
): TariffPlanState {
  return {
    id: 'tp-1',
    kindergartenId: KG,
    name: 'Standard',
    description: { ru: 'Стандарт' },
    tariffType: 'monthly',
    amount: MoneyKzt.fromKzt(50000),
    currency: 'KZT',
    appliesTo: 'all_children',
    groupId: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    isActive: true,
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: null,
    discountRules: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class FakeTariffPlanRepo extends TariffPlanRepository {
  rows = new Map<string, TariffPlan>();

  put(plan: TariffPlan): void {
    this.rows.set(plan.id, plan);
  }

  create(plan: TariffPlan): Promise<TariffPlan> {
    this.rows.set(plan.id, plan);
    return Promise.resolve(plan);
  }

  update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffPlanPatch,
    now: Date,
  ): Promise<TariffPlan | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.kindergartenId !== kindergartenId) {
      return Promise.resolve(null);
    }
    const s = existing.toState();
    const next = TariffPlan.fromState({
      ...s,
      name: patch.name ?? s.name,
      description: patch.description ?? s.description,
      amount:
        patch.amount !== undefined ? MoneyKzt.fromKzt(patch.amount) : s.amount,
      appliesTo: patch.appliesTo ?? s.appliesTo,
      groupId: patch.groupId !== undefined ? patch.groupId : s.groupId,
      ageMinMonths:
        patch.ageMinMonths !== undefined ? patch.ageMinMonths : s.ageMinMonths,
      ageMaxMonths:
        patch.ageMaxMonths !== undefined ? patch.ageMaxMonths : s.ageMaxMonths,
      isActive: patch.isActive ?? s.isActive,
      validFrom: patch.validFrom ?? s.validFrom,
      validUntil:
        patch.validUntil !== undefined ? patch.validUntil : s.validUntil,
      discountRules: patch.discountRules ?? s.discountRules,
      updatedAt: now,
    });
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  save(plan: TariffPlan): Promise<TariffPlan> {
    this.rows.set(plan.id, plan);
    return Promise.resolve(plan);
  }

  findById(kindergartenId: string, id: string): Promise<TariffPlan | null> {
    const p = this.rows.get(id);
    if (!p || p.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(p);
  }

  findActiveByType(
    kindergartenId: string,
    tariffType: TariffType,
    atDate?: Date,
  ): Promise<TariffPlan | null> {
    const at = atDate ?? new Date();
    const candidates = [...this.rows.values()].filter(
      (p) =>
        p.kindergartenId === kindergartenId &&
        p.tariffType === tariffType &&
        p.isActive &&
        p.validFrom.getTime() <= at.getTime() &&
        (p.validUntil === null || p.validUntil.getTime() >= at.getTime()),
    );
    candidates.sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
    return Promise.resolve(candidates[0] ?? null);
  }

  list(
    kindergartenId: string,
    filter: ListTariffPlansFilter = {},
  ): Promise<TariffPlan[]> {
    const out = [...this.rows.values()].filter((p) => {
      if (p.kindergartenId !== kindergartenId) return false;
      if (filter.isActive !== undefined && p.isActive !== filter.isActive) {
        return false;
      }
      if (
        filter.tariffType !== undefined &&
        p.tariffType !== filter.tariffType
      ) {
        return false;
      }
      if (filter.groupId !== undefined && p.groupId !== filter.groupId) {
        return false;
      }
      return true;
    });
    return Promise.resolve(out);
  }
}

describe('TariffPlanService', () => {
  let repo: FakeTariffPlanRepo;
  let clock: FakeClock;
  let svc: TariffPlanService;

  beforeEach(() => {
    repo = new FakeTariffPlanRepo();
    clock = new FakeClock(NOW);
    svc = new TariffPlanService(repo, clock);
  });

  describe('create', () => {
    it('returns a persisted plan with default currency KZT', async () => {
      const plan = await svc.create(KG, {
        name: 'Standard',
        tariffType: 'monthly',
        amount: 50000,
        appliesTo: 'all_children',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(plan.currency).toBe('KZT');
      expect(plan.isActive).toBe(true);
      expect(repo.rows.get(plan.id)).toBe(plan);
    });

    it('throws if appliesTo=group and groupId omitted (domain invariant)', async () => {
      await expect(
        svc.create(KG, {
          name: 'Group plan',
          tariffType: 'monthly',
          amount: 50000,
          appliesTo: 'group',
          validFrom: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ).rejects.toThrow(/groupId/);
    });
  });

  describe('update', () => {
    it('returns the patched plan', async () => {
      repo.put(TariffPlan.fromState(basePlanState()));
      const updated = await svc.update(KG, 'tp-1', { amount: 60000 });
      expect(updated.amount.toNumber()).toBe(60000);
    });

    it('throws TariffPlanNotFoundError for unknown id', async () => {
      await expect(svc.update(KG, 'missing', { amount: 1 })).rejects.toThrow(
        TariffPlanNotFoundError,
      );
    });

    it('throws TariffPlanNotFoundError for cross-tenant id', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-other',
            kindergartenId: '22222222-2222-2222-2222-222222222222',
          }),
        ),
      );
      await expect(svc.update(KG, 'tp-other', { amount: 1 })).rejects.toThrow(
        TariffPlanNotFoundError,
      );
    });
  });

  describe('deactivate', () => {
    it('flips isActive=false and sets validUntil', async () => {
      repo.put(TariffPlan.fromState(basePlanState()));
      const deactivated = await svc.deactivate(KG, 'tp-1');
      expect(deactivated.isActive).toBe(false);
      expect(deactivated.validUntil).not.toBeNull();
    });

    it('throws TariffPlanNotFoundError for unknown id', async () => {
      await expect(svc.deactivate(KG, 'missing')).rejects.toThrow(
        TariffPlanNotFoundError,
      );
    });
  });

  describe('list', () => {
    it('returns only the kg-scoped plans', async () => {
      repo.put(TariffPlan.fromState(basePlanState({ id: 'a' })));
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'b',
            kindergartenId: '22222222-2222-2222-2222-222222222222',
          }),
        ),
      );
      const list = await svc.list(KG);
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('a');
    });

    it('honours tariffType filter', async () => {
      repo.put(
        TariffPlan.fromState(basePlanState({ id: 'a', tariffType: 'monthly' })),
      );
      repo.put(
        TariffPlan.fromState(
          basePlanState({ id: 'b', tariffType: 'late_pickup_fee' }),
        ),
      );
      const list = await svc.list(KG, { tariffType: 'late_pickup_fee' });
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('b');
    });
  });

  describe('get', () => {
    it('returns the plan when found', async () => {
      repo.put(TariffPlan.fromState(basePlanState()));
      const plan = await svc.get(KG, 'tp-1');
      expect(plan.id).toBe('tp-1');
    });

    it('throws TariffPlanNotFoundError for unknown id', async () => {
      await expect(svc.get(KG, 'missing')).rejects.toThrow(
        TariffPlanNotFoundError,
      );
    });
  });
});
