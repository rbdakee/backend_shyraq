import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import {
  EntityManager,
  TransactionRunnerPort,
} from '@/shared-kernel/application/ports/transaction-runner.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import {
  TariffPlan,
  TariffPlanState,
} from './domain/entities/tariff-plan.entity';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import { TariffPlanOverlapError } from './domain/errors/tariff-plan-overlap.error';
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

// In-memory TransactionRunnerPort that invokes the callback with a stub
// EntityManager. The stub.query() is a no-op so service-layer
// `SET set_config(...)` calls don't fail. Mirrors the pattern other
// service-unit specs (custom-discount, payment, etc.) use.
class FakeTransactionRunner extends TransactionRunnerPort {
  query = jest.fn().mockResolvedValue(undefined);
  run<T>(cb: (manager: EntityManager) => Promise<T>): Promise<T> {
    const em = {
      query: this.query,
    } as unknown as EntityManager;
    return cb(em);
  }
}

class FakeTariffPlanRepo extends TariffPlanRepository {
  rows = new Map<string, TariffPlan>();
  // Ordering audit — populated whenever `acquireOverlapAdvisoryLock` or
  // `existsOverlap` fire. The B22b T15 Codex H2 invariant is that the
  // lock is acquired BEFORE `existsOverlap` for every code path that
  // mutates the catalogue. The unit spec asserts on this trace.
  callOrder: string[] = [];

  put(plan: TariffPlan): void {
    this.rows.set(plan.id, plan);
  }

  override acquireOverlapAdvisoryLock(): Promise<void> {
    this.callOrder.push('acquireOverlapAdvisoryLock');
    return Promise.resolve();
  }

  // Mirrors the relational impl: matches active rows with the same
  // (kg, tariff_type, applies_to[, group_id]) tuple whose [validFrom,
  // validUntil] window overlaps the proposed one. `individual` short-circuits.
  override existsOverlap(
    kindergartenId: string,
    tariffType: TariffPlan['tariffType'],
    appliesTo: TariffPlan['appliesTo'],
    groupId: string | null,
    validFrom: Date,
    validUntil: Date | null,
    excludeId?: string,
  ): Promise<boolean> {
    this.callOrder.push('existsOverlap');
    if (appliesTo === 'individual') return Promise.resolve(false);
    const fromMs = validFrom.getTime();
    const untilMs =
      validUntil === null ? Number.POSITIVE_INFINITY : validUntil.getTime();
    for (const p of this.rows.values()) {
      if (p.kindergartenId !== kindergartenId) continue;
      if (p.id === excludeId) continue;
      if (!p.isActive) continue;
      if (p.tariffType !== tariffType) continue;
      if (p.appliesTo !== appliesTo) continue;
      if (appliesTo === 'group' && p.groupId !== groupId) continue;
      const pFromMs = p.validFrom.getTime();
      const pUntilMs =
        p.validUntil === null
          ? Number.POSITIVE_INFINITY
          : p.validUntil.getTime();
      // overlap iff a1 <= b2 AND b1 <= a2
      if (pFromMs <= untilMs && fromMs <= pUntilMs) {
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
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
  let tx: FakeTransactionRunner;
  let svc: TariffPlanService;

  beforeEach(() => {
    repo = new FakeTariffPlanRepo();
    clock = new FakeClock(NOW);
    tx = new FakeTransactionRunner();
    svc = new TariffPlanService(repo, clock, tx);
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

  // ── overlap protection (B22b T6) ─────────────────────────────────────────

  describe('overlap protection', () => {
    it('throws TariffPlanOverlapError when create overlaps an existing active all_children plan of same type', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-existing',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: new Date('2026-12-31T00:00:00.000Z'),
          }),
        ),
      );
      await expect(
        svc.create(KG, {
          name: 'New plan',
          tariffType: 'monthly',
          amount: 60000,
          appliesTo: 'all_children',
          validFrom: new Date('2026-06-01T00:00:00.000Z'),
          validUntil: new Date('2027-05-31T00:00:00.000Z'),
        }),
      ).rejects.toThrow(TariffPlanOverlapError);
    });

    it('allows create when proposed window is strictly after the existing valid_until', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-old',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: new Date('2026-05-31T00:00:00.000Z'),
          }),
        ),
      );
      const plan = await svc.create(KG, {
        name: 'Next year',
        tariffType: 'monthly',
        amount: 60000,
        appliesTo: 'all_children',
        validFrom: new Date('2026-06-01T00:00:00.000Z'),
      });
      expect(plan.id).toBeDefined();
    });

    it('ignores an inactive existing plan during overlap check', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-inactive',
            isActive: false,
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: null,
          }),
        ),
      );
      const plan = await svc.create(KG, {
        name: 'Replacement',
        tariffType: 'monthly',
        amount: 70000,
        appliesTo: 'all_children',
        validFrom: new Date('2026-03-01T00:00:00.000Z'),
      });
      expect(plan.id).toBeDefined();
    });

    it('does not collide across different tariff_types', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-monthly',
            tariffType: 'monthly',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: null,
          }),
        ),
      );
      const plan = await svc.create(KG, {
        name: 'Late pickup',
        tariffType: 'late_pickup_fee',
        amount: 2000,
        appliesTo: 'all_children',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(plan.tariffType).toBe('late_pickup_fee');
    });

    it('isolates overlap check by group_id when applies_to=group', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-grp-A',
            appliesTo: 'group',
            groupId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: null,
          }),
        ),
      );
      // Different group → no overlap
      const plan = await svc.create(KG, {
        name: 'Group B plan',
        tariffType: 'monthly',
        amount: 50000,
        appliesTo: 'group',
        groupId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(plan.id).toBeDefined();

      // Same group → overlap
      await expect(
        svc.create(KG, {
          name: 'Group A duplicate',
          tariffType: 'monthly',
          amount: 50000,
          appliesTo: 'group',
          groupId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          validFrom: new Date('2026-06-01T00:00:00.000Z'),
        }),
      ).rejects.toThrow(TariffPlanOverlapError);
    });

    it('skips overlap entirely for applies_to=individual', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-ind-1',
            appliesTo: 'individual',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: null,
          }),
        ),
      );
      const plan = await svc.create(KG, {
        name: 'Another individual plan',
        tariffType: 'monthly',
        amount: 40000,
        appliesTo: 'individual',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      });
      expect(plan.appliesTo).toBe('individual');
    });

    it('rejects an update that would create an overlap on extended valid_until', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-1',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: new Date('2026-05-31T00:00:00.000Z'),
          }),
        ),
      );
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-2',
            validFrom: new Date('2026-06-01T00:00:00.000Z'),
            validUntil: new Date('2026-12-31T00:00:00.000Z'),
          }),
        ),
      );
      // tp-1 tries to extend until 2026-09-30 → overlaps tp-2
      await expect(
        svc.update(KG, 'tp-1', {
          validUntil: new Date('2026-09-30T00:00:00.000Z'),
        }),
      ).rejects.toThrow(TariffPlanOverlapError);
    });

    it('does not flag an update when only changing non-window fields', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-x',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: null,
          }),
        ),
      );
      // Adding a second plan with overlapping window would normally collide,
      // but here we only patch amount on the existing row.
      const updated = await svc.update(KG, 'tp-x', { amount: 99000 });
      expect(updated.amount.toNumber()).toBe(99000);
    });

    // ── B22b T15 Codex H2 — race-safe lock ordering ──────────────────────

    it('acquires the overlap advisory lock BEFORE existsOverlap on create', async () => {
      await svc.create(KG, {
        name: 'Standard',
        tariffType: 'monthly',
        amount: 50000,
        appliesTo: 'all_children',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      });
      const lockIdx = repo.callOrder.indexOf('acquireOverlapAdvisoryLock');
      const checkIdx = repo.callOrder.indexOf('existsOverlap');
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(checkIdx).toBeGreaterThan(lockIdx);
    });

    it('acquires the overlap advisory lock BEFORE existsOverlap on window-changing update', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-1',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: new Date('2026-05-31T00:00:00.000Z'),
          }),
        ),
      );
      repo.callOrder = [];
      await svc.update(KG, 'tp-1', {
        validUntil: new Date('2026-07-31T00:00:00.000Z'),
      });
      const lockIdx = repo.callOrder.indexOf('acquireOverlapAdvisoryLock');
      const checkIdx = repo.callOrder.indexOf('existsOverlap');
      expect(lockIdx).toBeGreaterThanOrEqual(0);
      expect(checkIdx).toBeGreaterThan(lockIdx);
    });

    it('skips the lock + overlap check entirely when update has no window changes', async () => {
      repo.put(
        TariffPlan.fromState(
          basePlanState({
            id: 'tp-no-window',
            validFrom: new Date('2026-01-01T00:00:00.000Z'),
            validUntil: null,
          }),
        ),
      );
      repo.callOrder = [];
      await svc.update(KG, 'tp-no-window', { amount: 88000 });
      expect(repo.callOrder).not.toContain('acquireOverlapAdvisoryLock');
      expect(repo.callOrder).not.toContain('existsOverlap');
    });
  });
});
