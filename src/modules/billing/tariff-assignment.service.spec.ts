import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import {
  TariffAssignment,
  TariffAssignmentState,
} from './domain/entities/tariff-assignment.entity';
import {
  TariffPlan,
  TariffPlanState,
} from './domain/entities/tariff-plan.entity';
import { TariffAssignmentNotFoundError } from './domain/errors/tariff-assignment-not-found.error';
import { TariffAssignmentOverlapError } from './domain/errors/tariff-assignment-overlap.error';
import { TariffPlanNotFoundError } from './domain/errors/tariff-plan-not-found.error';
import {
  CreateTariffAssignmentInput,
  ListTariffAssignmentsFilter,
  TariffAssignmentRepository,
  UpdateTariffAssignmentPatch,
} from './infrastructure/persistence/tariff-assignment.repository';
import { TariffPlanRepository } from './infrastructure/persistence/tariff-plan.repository';
import { TariffAssignmentService } from './tariff-assignment.service';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const STAFF = 'sssssssss-1111-2222-3333-ssssssssssss';
const PLAN = 'pppppppp-pppp-pppp-pppp-pppppppppppp';
const NOW = new Date('2026-05-04T09:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakeTariffAssignmentRepo extends TariffAssignmentRepository {
  rows = new Map<string, TariffAssignment>();
  private nextId = 0;

  put(a: TariffAssignment): void {
    this.rows.set(a.id, a);
  }

  create(input: CreateTariffAssignmentInput): Promise<TariffAssignment> {
    const id = `ta-${++this.nextId}`;
    const state: TariffAssignmentState = {
      id,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      tariffPlanId: input.tariffPlanId,
      customAmount:
        input.customAmount === null
          ? null
          : MoneyKzt.fromKzt(input.customAmount),
      customReason: input.customReason,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      assignedBy: input.assignedBy,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const a = TariffAssignment.fromState(state);
    this.rows.set(id, a);
    return Promise.resolve(a);
  }

  update(
    kindergartenId: string,
    id: string,
    patch: UpdateTariffAssignmentPatch,
    now: Date,
  ): Promise<TariffAssignment | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.kindergartenId !== kindergartenId) {
      return Promise.resolve(null);
    }
    const s = existing.toState();
    const next = TariffAssignment.fromState({
      ...s,
      tariffPlanId: patch.tariffPlanId ?? s.tariffPlanId,
      customAmount:
        patch.customAmount !== undefined
          ? patch.customAmount === null
            ? null
            : MoneyKzt.fromKzt(patch.customAmount)
          : s.customAmount,
      customReason:
        patch.customReason !== undefined ? patch.customReason : s.customReason,
      validFrom: patch.validFrom ?? s.validFrom,
      validUntil:
        patch.validUntil !== undefined ? patch.validUntil : s.validUntil,
      updatedAt: now,
    });
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  save(assignment: TariffAssignment): Promise<TariffAssignment> {
    this.rows.set(assignment.id, assignment);
    return Promise.resolve(assignment);
  }

  findById(
    kindergartenId: string,
    id: string,
  ): Promise<TariffAssignment | null> {
    const a = this.rows.get(id);
    if (!a || a.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(a);
  }

  findActiveForChild(
    kindergartenId: string,
    childId: string,
    atDate: Date,
  ): Promise<TariffAssignment | null> {
    const candidates = [...this.rows.values()].filter(
      (a) =>
        a.kindergartenId === kindergartenId &&
        a.childId === childId &&
        a.validFrom.getTime() <= atDate.getTime() &&
        (a.validUntil === null || a.validUntil.getTime() >= atDate.getTime()),
    );
    candidates.sort((a, b) => b.validFrom.getTime() - a.validFrom.getTime());
    return Promise.resolve(candidates[0] ?? null);
  }

  findAllActiveAtDate(
    kindergartenId: string,
    atDate: Date,
  ): Promise<TariffAssignment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (a) =>
          a.kindergartenId === kindergartenId &&
          a.validFrom.getTime() <= atDate.getTime() &&
          (a.validUntil === null || a.validUntil.getTime() >= atDate.getTime()),
      ),
    );
  }

  existsOverlap(
    kindergartenId: string,
    childId: string,
    validFrom: Date,
    validUntil: Date | null,
    excludeId?: string,
  ): Promise<boolean> {
    const fromMs = validFrom.getTime();
    const untilMs = validUntil
      ? validUntil.getTime()
      : Number.POSITIVE_INFINITY;
    for (const a of this.rows.values()) {
      if (a.kindergartenId !== kindergartenId) continue;
      if (a.childId !== childId) continue;
      if (excludeId && a.id === excludeId) continue;
      const aFrom = a.validFrom.getTime();
      const aUntil = a.validUntil
        ? a.validUntil.getTime()
        : Number.POSITIVE_INFINITY;
      if (aFrom <= untilMs && aUntil >= fromMs) {
        return Promise.resolve(true);
      }
    }
    return Promise.resolve(false);
  }

  list(
    kindergartenId: string,
    filter: ListTariffAssignmentsFilter = {},
  ): Promise<TariffAssignment[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((a) => {
        if (a.kindergartenId !== kindergartenId) return false;
        if (filter.childId && a.childId !== filter.childId) return false;
        return true;
      }),
    );
  }

  acquireAssignChildAdvisoryLock(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeTariffPlanRepo extends TariffPlanRepository {
  rows = new Map<string, TariffPlan>();

  put(p: TariffPlan): void {
    this.rows.set(p.id, p);
  }

  create(plan: TariffPlan): Promise<TariffPlan> {
    this.rows.set(plan.id, plan);
    return Promise.resolve(plan);
  }
  update(): Promise<TariffPlan | null> {
    return Promise.resolve(null);
  }
  save(plan: TariffPlan): Promise<TariffPlan> {
    this.rows.set(plan.id, plan);
    return Promise.resolve(plan);
  }
  findById(kg: string, id: string): Promise<TariffPlan | null> {
    const p = this.rows.get(id);
    if (!p || p.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(p);
  }
  findActiveByType(): Promise<TariffPlan | null> {
    return Promise.resolve(null);
  }
  list(kg: string): Promise<TariffPlan[]> {
    return Promise.resolve(
      [...this.rows.values()].filter((p) => p.kindergartenId === kg),
    );
  }
}

function planState(overrides: Partial<TariffPlanState> = {}): TariffPlanState {
  return {
    id: PLAN,
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

describe('TariffAssignmentService', () => {
  let repo: FakeTariffAssignmentRepo;
  let planRepo: FakeTariffPlanRepo;
  let svc: TariffAssignmentService;

  beforeEach(() => {
    repo = new FakeTariffAssignmentRepo();
    planRepo = new FakeTariffPlanRepo();
    // Seed the canonical plan id used across the spec so every test path
    // passes the cross-tenant tariff_plan validation (T11 H8) without
    // boilerplate per-test.
    planRepo.put(TariffPlan.fromState(planState()));
    svc = new TariffAssignmentService(repo, new FakeClock(NOW), planRepo);
  });

  describe('assign', () => {
    it('returns a persisted assignment for a clean child', async () => {
      const a = await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-05-01T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      expect(a.kindergartenId).toBe(KG);
      expect(a.childId).toBe(CHILD);
      expect(a.tariffPlanId).toBe(PLAN);
    });

    it('throws TariffAssignmentOverlapError when an overlapping window exists', async () => {
      await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validUntil: new Date('2026-12-31T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      await expect(
        svc.assign(KG, {
          childId: CHILD,
          tariffPlanId: PLAN,
          validFrom: new Date('2026-06-01T00:00:00.000Z'),
          assignedBy: STAFF,
        }),
      ).rejects.toThrow(TariffAssignmentOverlapError);
    });

    it('allows non-overlapping consecutive windows', async () => {
      await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validUntil: new Date('2026-05-31T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      const next = await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-06-01T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      expect(next).toBeDefined();
    });

    it('throws TariffPlanNotFoundError when tariff_plan_id is unknown to caller kg (T11 H8)', async () => {
      // Plan exists in another kg (KG2) but caller is in KG → RLS-scoped
      // findById returns null → not_found.
      const KG2 = '22222222-2222-2222-2222-222222222222';
      planRepo.put(
        TariffPlan.fromState(
          planState({ id: 'kg2-plan', kindergartenId: KG2 }),
        ),
      );
      await expect(
        svc.assign(KG, {
          childId: CHILD,
          tariffPlanId: 'kg2-plan',
          validFrom: new Date('2026-05-01T00:00:00.000Z'),
          assignedBy: STAFF,
        }),
      ).rejects.toThrow(TariffPlanNotFoundError);
    });
  });

  describe('update', () => {
    it('returns the patched assignment when window does not overlap', async () => {
      const a = await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-05-01T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      const updated = await svc.update(KG, a.id, {
        customAmount: 70000,
        customReason: 'discount sponsor',
      });
      expect(updated.customAmount?.toNumber()).toBe(70000);
      expect(updated.customReason).toBe('discount sponsor');
    });

    it('throws TariffAssignmentNotFoundError for unknown id', async () => {
      await expect(
        svc.update(KG, 'missing', { customAmount: 1 }),
      ).rejects.toThrow(TariffAssignmentNotFoundError);
    });

    it('rejects an update that creates an overlap with another row', async () => {
      const a = await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validUntil: new Date('2026-05-31T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-06-01T00:00:00.000Z'),
        validUntil: new Date('2026-12-31T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      await expect(
        svc.update(KG, a.id, {
          validUntil: new Date('2026-08-31T00:00:00.000Z'),
        }),
      ).rejects.toThrow(TariffAssignmentOverlapError);
    });
  });

  describe('close', () => {
    it('sets validUntil', async () => {
      const a = await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-05-01T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      const closed = await svc.close(KG, a.id);
      expect(closed.validUntil).not.toBeNull();
    });

    it('throws TariffAssignmentNotFoundError for unknown id', async () => {
      await expect(svc.close(KG, 'missing')).rejects.toThrow(
        TariffAssignmentNotFoundError,
      );
    });
  });

  describe('list / get / findActiveForChild', () => {
    it('list filters by childId', async () => {
      await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-05-01T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      const list = await svc.list(KG, { childId: CHILD });
      expect(list).toHaveLength(1);
    });

    it('get returns the assignment', async () => {
      const a = await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-05-01T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      const fetched = await svc.get(KG, a.id);
      expect(fetched.id).toBe(a.id);
    });

    it('get throws TariffAssignmentNotFoundError for unknown id', async () => {
      await expect(svc.get(KG, 'missing')).rejects.toThrow(
        TariffAssignmentNotFoundError,
      );
    });

    it('findActiveForChild returns null when no assignment covers atDate', async () => {
      const result = await svc.findActiveForChild(
        KG,
        CHILD,
        new Date('2026-05-01T00:00:00.000Z'),
      );
      expect(result).toBeNull();
    });

    it('findActiveForChild returns the active row', async () => {
      await svc.assign(KG, {
        childId: CHILD,
        tariffPlanId: PLAN,
        validFrom: new Date('2026-05-01T00:00:00.000Z'),
        assignedBy: STAFF,
      });
      const result = await svc.findActiveForChild(
        KG,
        CHILD,
        new Date('2026-05-15T00:00:00.000Z'),
      );
      expect(result).not.toBeNull();
    });
  });
});
