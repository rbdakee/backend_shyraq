/**
 * MealService — service-unit suite. All collaborators are hand-written
 * in-memory fakes (no Jest auto-mock, no DB, no NestJS runtime).
 */
import { Child } from '@/modules/child/domain/entities/child.entity';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MealPlan } from './domain/entities/meal-plan.entity';
import { InvalidDateRangeError } from './domain/errors/invalid-date-range.error';
import { MealItemNotFoundError } from './domain/errors/meal-item-not-found.error';
import { MealPlanAlreadyExistsError } from './domain/errors/meal-plan-already-exists.error';
import { MealPlanNotFoundError } from './domain/errors/meal-plan-not-found.error';
import {
  ListMealPlansFilter,
  MealPlanRepository,
} from './infrastructure/persistence/meal-plan.repository';
import { MealService } from './meal.service';

// ── Fakes ────────────────────────────────────────────────────────────────

class FixedClock extends ClockPort {
  constructor(private readonly t: Date) {
    super();
  }
  now(): Date {
    return this.t;
  }
}

const NOW = new Date('2026-05-01T08:00:00.000Z');

class FakeMealPlanRepository extends MealPlanRepository {
  rows = new Map<string, MealPlan>();
  shouldThrowAlreadyExists = false;

  private clone(p: MealPlan): MealPlan {
    return MealPlan.hydrate(p.toState());
  }

  create(_kgId: string, plan: MealPlan): Promise<MealPlan> {
    if (this.shouldThrowAlreadyExists) {
      return Promise.reject(
        new MealPlanAlreadyExistsError(_kgId, plan.date, plan.groupId),
      );
    }
    this.rows.set(plan.id, this.clone(plan));
    return Promise.resolve(this.clone(plan));
  }

  findById(_kgId: string, planId: string): Promise<MealPlan | null> {
    const p = this.rows.get(planId);
    return Promise.resolve(p ? this.clone(p) : null);
  }

  list(_kgId: string, filter: ListMealPlansFilter): Promise<MealPlan[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (p) =>
            p.kindergartenId === _kgId &&
            p.date >= filter.dateFrom &&
            p.date <= filter.dateTo &&
            (filter.groupId === undefined || p.groupId === filter.groupId),
        )
        .map((p) => this.clone(p)),
    );
  }

  update(_kgId: string, plan: MealPlan): Promise<MealPlan> {
    this.rows.set(plan.id, this.clone(plan));
    return Promise.resolve(this.clone(plan));
  }

  delete(_kgId: string, planId: string): Promise<void> {
    this.rows.delete(planId);
    return Promise.resolve();
  }

  addItem(_planId: string, plan: MealPlan): Promise<MealPlan> {
    this.rows.set(plan.id, this.clone(plan));
    return Promise.resolve(this.clone(plan));
  }

  updateItem(_planId: string, plan: MealPlan): Promise<MealPlan> {
    this.rows.set(plan.id, this.clone(plan));
    return Promise.resolve(this.clone(plan));
  }

  removeItem(
    _planId: string,
    _itemId: string,
    plan: MealPlan,
  ): Promise<MealPlan> {
    this.rows.set(plan.id, this.clone(plan));
    return Promise.resolve(this.clone(plan));
  }

  listForWeek(
    _kgId: string,
    weekStart: string,
    groupId: string | null,
  ): Promise<MealPlan[]> {
    const end = new Date(weekStart);
    end.setDate(end.getDate() + 6);
    const dateTo = end.toISOString().slice(0, 10);
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (p) =>
            p.kindergartenId === _kgId &&
            p.isPublished &&
            p.date >= weekStart &&
            p.date <= dateTo &&
            (groupId === null
              ? p.groupId === null
              : p.groupId === groupId || p.groupId === null),
        )
        .map((p) => this.clone(p)),
    );
  }

  existsAnyInRange(_kgId: string, from: string, to: string): Promise<boolean> {
    const found = [...this.rows.values()].some(
      (p) => p.kindergartenId === _kgId && p.date >= from && p.date <= to,
    );
    return Promise.resolve(found);
  }

  batchCreate(
    _kgId: string,
    plans: MealPlan[],
  ): Promise<{ plans_created: number; plans_skipped: number }> {
    let plans_created = 0;
    let plans_skipped = 0;
    for (const plan of plans) {
      // Check for existing plan (simple idempotency)
      const existing = [...this.rows.values()].find(
        (p) =>
          p.kindergartenId === _kgId &&
          p.date === plan.date &&
          p.groupId === plan.groupId,
      );
      if (existing) {
        plans_skipped++;
      } else {
        this.rows.set(plan.id, this.clone(plan));
        plans_created++;
      }
    }
    return Promise.resolve({ plans_created, plans_skipped });
  }

  acquireWeekCopyLock(_kgId: string, _weekStartIso: string): Promise<void> {
    return Promise.resolve();
  }
}

class FakeGroupRepository extends GroupRepository {
  private groups = new Map<string, Group>();

  seedGroup(g: Group): void {
    this.groups.set(g.id, g);
  }

  findById(kgId: string, id: string): Promise<Group | null> {
    const g = this.groups.get(id);
    return Promise.resolve(g && g.kindergartenId === kgId ? g : null);
  }

  create(_kgId: string, _input: CreateGroupInput): Promise<Group> {
    return Promise.reject(new Error('not impl'));
  }
  list(_kgId: string, _f?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve([]);
  }
  update(
    _kgId: string,
    _id: string,
    _patch: UpdateGroupInput,
  ): Promise<Group | null> {
    return Promise.resolve(null);
  }
  save(g: Group): Promise<Group> {
    return Promise.resolve(g);
  }
  assignMentor(
    _kgId: string,
    _gId: string,
    _smId: string,
    _now: Date,
  ): Promise<GroupMentor> {
    return Promise.reject(new Error('not impl'));
  }
  unassignMentor(
    _kgId: string,
    _gId: string,
    _now: Date,
  ): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  unassignMentorByStaffMember(
    _kgId: string,
    _smId: string,
    _now: Date,
  ): Promise<number> {
    return Promise.resolve(0);
  }
  findActiveMentor(_kgId: string, _gId: string): Promise<GroupMentor | null> {
    return Promise.resolve(null);
  }
  listMentorHistory(_kgId: string, _gId: string): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
  findActiveMentorAssignmentsByUserIdCrossTenant(
    _userId: string,
  ): Promise<GroupMentor[]> {
    return Promise.resolve([]);
  }
}

class FakeChildRepository extends ChildRepository {
  private children = new Map<string, Child>();

  seedChild(c: Child): void {
    this.children.set(c.id, c);
  }

  create(_c: Child): Promise<void> {
    return Promise.resolve();
  }
  findById(_kgId: string, id: string): Promise<Child | null> {
    return Promise.resolve(this.children.get(id) ?? null);
  }
  findByKindergartenAndIin(_kgId: string, _iin: string): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(_c: Child): Promise<void> {
    return Promise.resolve();
  }
  list(
    _kgId: string,
    _f: ChildListFilters,
    _p: PageRequest,
  ): Promise<PageResult<Child>> {
    return Promise.resolve({ items: [], total: 0 });
  }
  countActiveByGroup(_kgId: string, _gId: string): Promise<number> {
    return Promise.resolve(0);
  }
  recordGroupTransfer(
    _kgId: string,
    _cId: string,
    _from: string | null,
    _to: string,
    _by: string,
    _reason: string | null,
    _at: Date,
  ): Promise<void> {
    return Promise.resolve();
  }
  listGroupHistory(
    _kgId: string,
    _cId: string,
  ): Promise<ChildGroupHistoryRecord[]> {
    return Promise.resolve([]);
  }
  findByIinCrossTenant(_iin: string): Promise<Child[]> {
    return Promise.resolve([]);
  }
  findByIdsCrossTenant(_ids: string[]): Promise<Child[]> {
    return Promise.resolve([]);
  }
}

// ── constants ─────────────────────────────────────────────────────────────

const CHILD_UUID = '00000000-0000-0000-0000-000000000001';
const KG_UUID = '00000000-0000-0000-0000-000000000002';
const GROUP_UUID = '00000000-0000-0000-0000-000000000003';

// ── helpers ───────────────────────────────────────────────────────────────

function makeService(
  planRepo: FakeMealPlanRepository,
  groupRepo: FakeGroupRepository,
  childRepo: FakeChildRepository,
): MealService {
  return new MealService(planRepo, groupRepo, childRepo, new FixedClock(NOW));
}

function seedGroup(groupRepo: FakeGroupRepository): Group {
  const g = Group.hydrate({
    id: GROUP_UUID,
    kindergartenId: KG_UUID,
    name: 'Alpha',
    capacity: 20,
    ageRangeMin: null,
    ageRangeMax: null,
    currentLocationId: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  groupRepo.seedGroup(g);
  return g;
}

function seedChild(childRepo: FakeChildRepository, groupId?: string): Child {
  const c = Child.hydrate({
    id: CHILD_UUID,
    kindergartenId: KG_UUID,
    iin: null,
    fullName: 'Alice',
    dateOfBirth: new Date('2020-01-01'),
    gender: null,
    photoUrl: null,
    status: 'card_created',
    currentGroupId: groupId ?? null,
    enrollmentDate: null,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  childRepo.seedChild(c);
  return c;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('MealService', () => {
  describe('createPlan', () => {
    it('returns the created plan', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      const plan = await svc.createPlan(KG_UUID, { date: '2026-05-01' });
      expect(plan.date).toBe('2026-05-01');
      expect(plan.kindergartenId).toBe(KG_UUID);
      expect(plan.source).toBe('manual');
    });

    it('throws GroupNotFoundError when group_id is invalid', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      await expect(
        svc.createPlan(KG_UUID, { date: '2026-05-01', groupId: 'nonexistent' }),
      ).rejects.toThrow(GroupNotFoundError);
    });

    it('throws MealPlanAlreadyExistsError on duplicate (unique constraint)', async () => {
      const planRepo = new FakeMealPlanRepository();
      planRepo.shouldThrowAlreadyExists = true;
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      await expect(
        svc.createPlan(KG_UUID, { date: '2026-05-01' }),
      ).rejects.toThrow(MealPlanAlreadyExistsError);
    });

    it('creates a plan with group_id when group exists', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      seedGroup(groupRepo);
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      const plan = await svc.createPlan(KG_UUID, {
        date: '2026-05-01',
        groupId: GROUP_UUID,
      });
      expect(plan.groupId).toBe(GROUP_UUID);
    });
  });

  describe('updatePlan', () => {
    it('updates is_published and notes', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      const plan = await svc.createPlan(KG_UUID, {
        date: '2026-05-01',
        isPublished: true,
      });
      const updated = await svc.updatePlan(KG_UUID, plan.id, {
        isPublished: false,
        notes: { ru: 'Особое меню' },
      });
      expect(updated.isPublished).toBe(false);
      expect((updated.notes as any)?.ru).toBe('Особое меню');
    });

    it('throws MealPlanNotFoundError for unknown plan', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      await expect(
        svc.updatePlan(KG_UUID, 'missing-id', { isPublished: false }),
      ).rejects.toThrow(MealPlanNotFoundError);
    });
  });

  describe('listPlans', () => {
    it('returns plans within the date range', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      await svc.createPlan(KG_UUID, { date: '2026-05-01' });
      await svc.createPlan(KG_UUID, { date: '2026-05-02' });
      await svc.createPlan(KG_UUID, { date: '2026-05-10' });

      const results = await svc.listPlans(KG_UUID, {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-05',
      });
      expect(results).toHaveLength(2);
    });

    it('throws InvalidDateRangeError when from > to', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      await expect(
        svc.listPlans(KG_UUID, {
          dateFrom: '2026-05-10',
          dateTo: '2026-05-01',
        }),
      ).rejects.toThrow(InvalidDateRangeError);
    });

    it('filters by groupId when provided', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      seedGroup(groupRepo);
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      await svc.createPlan(KG_UUID, { date: '2026-05-01' }); // kg-wide
      await svc.createPlan(KG_UUID, {
        date: '2026-05-01',
        groupId: GROUP_UUID,
      }); // group

      const results = await svc.listPlans(KG_UUID, {
        dateFrom: '2026-05-01',
        dateTo: '2026-05-01',
        groupId: GROUP_UUID,
      });
      expect(results).toHaveLength(1);
      expect(results[0].groupId).toBe(GROUP_UUID);
    });
  });

  describe('addItem / updateItem / removeItem', () => {
    it('addItem appends item to plan', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      const plan = await svc.createPlan(KG_UUID, { date: '2026-05-01' });
      const updated = await svc.addItem(KG_UUID, plan.id, {
        mealType: 'breakfast',
        dishName: { ru: 'Каша' },
      });
      expect(updated.items).toHaveLength(1);
      expect(updated.items[0].mealType).toBe('breakfast');
    });

    it('removeItem throws MealItemNotFoundError for unknown item', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      const plan = await svc.createPlan(KG_UUID, { date: '2026-05-01' });
      await expect(
        svc.removeItem(KG_UUID, plan.id, 'unknown-item-id'),
      ).rejects.toThrow(MealItemNotFoundError);
    });
  });

  describe('getMenuForChild', () => {
    it('returns 7-day week menu with published plans', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      seedGroup(groupRepo);
      const childRepo = new FakeChildRepository();
      seedChild(childRepo, GROUP_UUID);
      const svc = makeService(planRepo, groupRepo, childRepo);

      // Seed a published plan for Monday
      const plan = MealPlan.create({
        id: 'p-monday',
        kindergartenId: KG_UUID,
        date: '2026-04-27',
        groupId: GROUP_UUID,
        isPublished: true,
        now: NOW,
      });
      planRepo.rows.set(plan.id, plan);

      const result = await svc.getMenuForChild(
        KG_UUID,
        CHILD_UUID,
        '2026-04-27',
      );
      expect(result.week_start).toBe('2026-04-27');
      expect(result.days).toHaveLength(7);

      const monday = result.days.find((d) => d.date === '2026-04-27');
      expect(monday?.plan).not.toBeNull();
    });

    it('returns only published plans (is_published=false is hidden)', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      seedGroup(groupRepo);
      const childRepo = new FakeChildRepository();
      seedChild(childRepo, GROUP_UUID);
      const svc = makeService(planRepo, groupRepo, childRepo);

      const unpublished = MealPlan.create({
        id: 'p-unpublished',
        kindergartenId: KG_UUID,
        date: '2026-04-27',
        groupId: GROUP_UUID,
        isPublished: false,
        now: NOW,
      });
      planRepo.rows.set(unpublished.id, unpublished);

      const result = await svc.getMenuForChild(
        KG_UUID,
        CHILD_UUID,
        '2026-04-27',
      );
      const monday = result.days.find((d) => d.date === '2026-04-27');
      expect(monday?.plan).toBeNull();
    });
  });

  describe('copyWeekMenuToNext', () => {
    it('copies plans to next week and returns counts', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      // Seed 5 plans for current week (Mon-Fri)
      for (let i = 0; i < 5; i++) {
        const d = new Date('2026-04-27');
        d.setDate(d.getDate() + i);
        const plan = MealPlan.create({
          id: `plan-${i}`,
          kindergartenId: KG_UUID,
          date: d.toISOString().slice(0, 10),
          groupId: null,
          isPublished: true,
          now: NOW,
        });
        planRepo.rows.set(plan.id, plan);
      }

      const result = await svc.copyWeekMenuToNext(
        KG_UUID,
        new Date('2026-04-27'),
        'manual',
      );
      expect(result.plans_created).toBe(5);
      expect(result.plans_skipped).toBe(0);
    });

    it('is idempotent — re-copy skips already-existing target plans', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      // Seed source plan
      const plan = MealPlan.create({
        id: 'src-plan',
        kindergartenId: KG_UUID,
        date: '2026-04-27',
        groupId: null,
        isPublished: true,
        now: NOW,
      });
      planRepo.rows.set(plan.id, plan);

      // First copy
      await svc.copyWeekMenuToNext(KG_UUID, new Date('2026-04-27'), 'manual');

      // Second copy should skip
      const result = await svc.copyWeekMenuToNext(
        KG_UUID,
        new Date('2026-04-27'),
        'manual',
      );
      expect(result.plans_skipped).toBe(1);
      expect(result.plans_created).toBe(0);
    });

    it('returns zero counts when no source plans exist', async () => {
      const planRepo = new FakeMealPlanRepository();
      const groupRepo = new FakeGroupRepository();
      const childRepo = new FakeChildRepository();
      const svc = makeService(planRepo, groupRepo, childRepo);

      const result = await svc.copyWeekMenuToNext(
        KG_UUID,
        new Date('2026-04-27'),
        'cron',
      );
      expect(result.plans_created).toBe(0);
      expect(result.plans_skipped).toBe(0);
    });
  });
});
