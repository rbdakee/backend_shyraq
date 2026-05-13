import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MoneyKzt } from '@/shared-kernel/domain/money-kzt';
import { TariffAssignmentRepository } from './infrastructure/persistence/tariff-assignment.repository';
import { CustomDiscount } from './domain/entities/custom-discount.entity';
import { DiscountTargetResolver } from './discount-target-resolver';

const KG = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-06-01T09:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private readonly d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakeChildRepo {
  allActive: string[] = [];
  byGroup = new Map<string, string[]>();
  inKgFilter = new Set<string>();
  ageRangeIds: string[] = [];

  listAllActiveIdsByKg(_kgId: string): Promise<string[]> {
    return Promise.resolve(this.allActive);
  }

  listActiveIdsByGroupIds(
    _kgId: string,
    groupIds: string[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const gid of groupIds) {
      const v = this.byGroup.get(gid);
      if (v) ids.push(...v);
    }
    return Promise.resolve(ids);
  }

  findActiveIdsInKg(_kgId: string, ids: string[]): Promise<string[]> {
    return Promise.resolve(ids.filter((id) => this.inKgFilter.has(id)));
  }

  listActiveIdsInKgInAgeRange(
    _kgId: string,
    _from: number,
    _to: number,
    _now: Date,
  ): Promise<string[]> {
    return Promise.resolve(this.ageRangeIds);
  }
}

class FakeTariffRepo {
  byPlan = new Map<string, string[]>();

  listActiveChildIdsByTariffPlanIds(
    _kgId: string,
    planIds: string[],
    _now: Date,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const pid of planIds) {
      const v = this.byPlan.get(pid);
      if (v) out.push(...v);
    }
    return Promise.resolve(out);
  }
}

function makeDiscount(overrides: {
  targetType: 'all' | 'groups' | 'children' | 'tariff_types' | 'age_range';
  targetIds: string[] | null;
  conditions?: Record<string, unknown>;
}): CustomDiscount {
  return CustomDiscount.fromState({
    id: 'd-1',
    kindergartenId: KG,
    name: { ru: 'X' },
    description: null,
    discountType: 'percentage',
    amount: MoneyKzt.fromKzt(10),
    conditions: (overrides.conditions ?? {}) as Record<string, never>,
    targetType: overrides.targetType,
    targetIds: overrides.targetIds,
    validFrom: NOW,
    validUntil: null,
    maxUsesPerChild: null,
    totalMaxUses: null,
    usedCount: 0,
    priority: 100,
    stackable: false,
    notifyOnActivation: true,
    notificationTitle: { ru: 'X' },
    notificationBody: { ru: 'Y' },
    status: 'draft',
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function buildResolver(): {
  resolver: DiscountTargetResolver;
  childRepo: FakeChildRepo;
  tariffRepo: FakeTariffRepo;
} {
  const childRepo = new FakeChildRepo();
  const tariffRepo = new FakeTariffRepo();
  const resolver = new DiscountTargetResolver(
    childRepo as unknown as ChildRepository,
    tariffRepo as unknown as TariffAssignmentRepository,
    new FakeClock(NOW),
  );
  return { resolver, childRepo, tariffRepo };
}

describe('DiscountTargetResolver', () => {
  it("targetType='all' → returns all active children in kg", async () => {
    const { resolver, childRepo } = buildResolver();
    childRepo.allActive = ['c-1', 'c-2', 'c-3'];
    const d = makeDiscount({ targetType: 'all', targetIds: null });
    const ids = await resolver.resolveTargetChildIds(KG, d);
    expect(ids).toEqual(new Set(['c-1', 'c-2', 'c-3']));
  });

  it("targetType='groups' → resolves children via group ids", async () => {
    const { resolver, childRepo } = buildResolver();
    childRepo.byGroup.set('g-1', ['c-1', 'c-2']);
    childRepo.byGroup.set('g-2', ['c-3']);
    const d = makeDiscount({ targetType: 'groups', targetIds: ['g-1', 'g-2'] });
    const ids = await resolver.resolveTargetChildIds(KG, d);
    expect(ids).toEqual(new Set(['c-1', 'c-2', 'c-3']));
  });

  it("targetType='children' → filters input ids through findActiveIdsInKg", async () => {
    const { resolver, childRepo } = buildResolver();
    childRepo.inKgFilter.add('c-1');
    childRepo.inKgFilter.add('c-2');
    const d = makeDiscount({
      targetType: 'children',
      targetIds: ['c-1', 'c-2', 'phantom-cross-kg'],
    });
    const ids = await resolver.resolveTargetChildIds(KG, d);
    expect(ids).toEqual(new Set(['c-1', 'c-2']));
  });

  it("targetType='tariff_types' → resolves via TariffAssignmentRepository", async () => {
    const { resolver, tariffRepo } = buildResolver();
    tariffRepo.byPlan.set('plan-A', ['c-10', 'c-11']);
    const d = makeDiscount({
      targetType: 'tariff_types',
      targetIds: ['plan-A'],
    });
    const ids = await resolver.resolveTargetChildIds(KG, d);
    expect(ids).toEqual(new Set(['c-10', 'c-11']));
  });

  it("targetType='tariff_types' with no ids returns empty set", async () => {
    const { resolver } = buildResolver();
    const d = makeDiscount({
      targetType: 'tariff_types',
      targetIds: ['plan-A'],
    });
    const ids = await resolver.resolveTargetChildIds(KG, d);
    expect(ids).toEqual(new Set());
  });

  it("targetType='age_range' → resolves via age range from conditions", async () => {
    const { resolver, childRepo } = buildResolver();
    childRepo.ageRangeIds = ['c-young-1', 'c-young-2'];
    const d = makeDiscount({
      targetType: 'age_range',
      targetIds: null,
      conditions: { type: 'age_range', from_months: 12, to_months: 36 },
    });
    const ids = await resolver.resolveTargetChildIds(KG, d);
    expect(ids).toEqual(new Set(['c-young-1', 'c-young-2']));
  });

  it("targetType='age_range' with no age_range condition returns empty set", async () => {
    const { resolver } = buildResolver();
    const d = makeDiscount({ targetType: 'age_range', targetIds: null });
    const ids = await resolver.resolveTargetChildIds(KG, d);
    expect(ids).toEqual(new Set());
  });

  it('filterDiscountsForChild keeps only discounts whose target set includes the child', async () => {
    const { resolver, childRepo } = buildResolver();
    childRepo.allActive = ['c-1', 'c-2'];
    const matchingSnap = {
      id: 'd-all',
      name: { ru: 'X' },
      discountType: 'percentage' as const,
      amount: MoneyKzt.fromKzt(10),
      conditions: {} as Record<string, never>,
      targetType: 'all' as const,
      targetIds: null as string[] | null,
      priority: 100,
      stackable: false,
      maxUsesPerChild: null,
      totalMaxUses: null,
      usedCount: 0,
      createdAt: NOW,
    };
    childRepo.byGroup.set('g-only-99', ['c-99']);
    const nonMatchingSnap = {
      ...matchingSnap,
      id: 'd-other',
      targetType: 'groups' as const,
      targetIds: ['g-only-99'],
    };
    const out = await resolver.filterDiscountsForChild(KG, 'c-1', [
      matchingSnap,
      nonMatchingSnap,
    ]);
    expect(out.map((s) => s.id)).toEqual(['d-all']);
  });
});
