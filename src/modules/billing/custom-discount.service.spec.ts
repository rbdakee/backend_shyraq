import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager } from 'typeorm';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import {
  CreateCustomDiscountApplicationInput,
  CustomDiscountApplicationRepository,
  CustomDiscountApplicationStats,
} from './custom-discount-application.repository';
import {
  CreateCustomDiscountInput,
  CustomDiscountPageRequest,
  CustomDiscountRepository,
  ListCustomDiscountsFilter,
  UpdateCustomDiscountPatch,
} from './custom-discount.repository';
import {
  CustomDiscount,
  CustomDiscountState,
  CustomDiscountStatus,
} from './domain/entities/custom-discount.entity';
import { CustomDiscountApplication } from './domain/entities/custom-discount-application.entity';
import { CustomDiscountNotFoundError } from './domain/errors/custom-discount-not-found.error';
import { CustomDiscountStatusInvalidError } from './domain/errors/custom-discount-status-invalid.error';
import { CustomDiscountConditionsInvalidError } from './domain/errors/custom-discount-conditions-invalid.error';
import { DiscountTargetResolver } from './discount-target-resolver';
import { CustomDiscountService } from './custom-discount.service';

const KG = '11111111-1111-1111-1111-111111111111';
const KG_OTHER = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-06-01T09:00:00.000Z');
const VALID_FROM = new Date('2026-06-01T00:00:00.000Z');
const VALID_UNTIL = new Date('2026-12-31T23:59:59.000Z');

class FakeClock extends ClockPort {
  constructor(private readonly d: Date) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakeDataSource {
  // Just enough surface to call transaction(em => …) — we pass a stub EM
  // whose `query` is a no-op (the GUC SET LOCAL is a runtime-only concern;
  // the in-memory fake repo doesn't read GUC).
  transaction<T>(cb: (em: EntityManager) => Promise<T>): Promise<T> {
    const stub = {
      query: () => Promise.resolve([]),
    } as unknown as EntityManager;
    return cb(stub);
  }
}

class FakeCustomDiscountRepo extends CustomDiscountRepository {
  rows = new Map<string, CustomDiscount>();
  expiredCalls: Array<{ kgId: string; now: Date }> = [];
  activationLockCalls: Array<{ kgId: string; id: string }> = [];

  put(d: CustomDiscount): void {
    this.rows.set(d.id, d);
  }

  create(input: CreateCustomDiscountInput): Promise<CustomDiscount> {
    const id = randomUUID();
    const state: CustomDiscountState = {
      id,
      kindergartenId: input.kindergartenId,
      name: input.name,
      description: input.description,
      discountType: input.discountType,
      amount: input.amount,
      conditions: input.conditions,
      targetType: input.targetType,
      targetIds: input.targetIds,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      maxUsesPerChild: input.maxUsesPerChild,
      totalMaxUses: input.totalMaxUses,
      usedCount: 0,
      priority: input.priority,
      stackable: input.stackable,
      notifyOnActivation: input.notifyOnActivation,
      notificationTitle: input.notificationTitle,
      notificationBody: input.notificationBody,
      status: 'draft',
      createdBy: input.createdBy,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const d = CustomDiscount.fromState(state);
    this.rows.set(id, d);
    return Promise.resolve(d);
  }

  findById(kindergartenId: string, id: string): Promise<CustomDiscount | null> {
    const d = this.rows.get(id);
    if (!d || d.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(d);
  }

  findByIdForUpdate(
    kindergartenId: string,
    id: string,
  ): Promise<CustomDiscount | null> {
    return this.findById(kindergartenId, id);
  }

  update(
    kindergartenId: string,
    id: string,
    patch: UpdateCustomDiscountPatch,
    expectedStatus?: CustomDiscountStatus,
  ): Promise<CustomDiscount | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.kindergartenId !== kindergartenId) {
      return Promise.resolve(null);
    }
    if (expectedStatus !== undefined && existing.status !== expectedStatus) {
      return Promise.resolve(null);
    }
    const merged: CustomDiscountState = {
      ...existing.toState(),
      ...patch,
      updatedAt: NOW,
    };
    const next = CustomDiscount.fromState(merged);
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  transitionStatus(
    kindergartenId: string,
    id: string,
    fromStatus: CustomDiscountStatus | CustomDiscountStatus[],
    toStatus: CustomDiscountStatus,
    now: Date,
  ): Promise<CustomDiscount | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.kindergartenId !== kindergartenId) {
      return Promise.resolve(null);
    }
    const expected = Array.isArray(fromStatus) ? fromStatus : [fromStatus];
    if (!expected.includes(existing.status)) return Promise.resolve(null);
    const next = CustomDiscount.fromState({
      ...existing.toState(),
      status: toStatus,
      updatedAt: now,
    });
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  list(
    kindergartenId: string,
    filter: ListCustomDiscountsFilter,
    pagination: CustomDiscountPageRequest,
  ): Promise<{ rows: CustomDiscount[]; total: number }> {
    const all = [...this.rows.values()].filter(
      (d) =>
        d.kindergartenId === kindergartenId &&
        (filter.status === undefined || d.status === filter.status) &&
        (filter.targetType === undefined || d.targetType === filter.targetType),
    );
    const total = all.length;
    const rows = all.slice(
      pagination.offset,
      pagination.offset + pagination.limit,
    );
    return Promise.resolve({ rows, total });
  }

  incrementUsedCount(
    kindergartenId: string,
    id: string,
    by: number,
  ): Promise<boolean> {
    const existing = this.rows.get(id);
    if (!existing || existing.kindergartenId !== kindergartenId) {
      return Promise.resolve(false);
    }
    const s = existing.toState();
    if (s.totalMaxUses !== null && s.usedCount + by > s.totalMaxUses) {
      return Promise.resolve(false);
    }
    this.rows.set(
      id,
      CustomDiscount.fromState({ ...s, usedCount: s.usedCount + by }),
    );
    return Promise.resolve(true);
  }

  findActiveCustomDiscounts(
    kindergartenId: string,
    now: Date,
  ): Promise<CustomDiscount[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((d) => d.kindergartenId === kindergartenId)
        .filter((d) => d.isActive(now))
        .sort((a, b) => {
          if (a.priority !== b.priority) return b.priority - a.priority;
          return a.createdAt.getTime() - b.createdAt.getTime();
        }),
    );
  }

  findOverdueActive(
    kindergartenId: string,
    now: Date,
  ): Promise<CustomDiscount[]> {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (d) =>
          d.kindergartenId === kindergartenId &&
          d.status === 'active' &&
          d.validUntil !== null &&
          d.validUntil.getTime() <= now.getTime(),
      ),
    );
  }

  markExpiredBatch(
    kindergartenId: string,
    now: Date,
  ): Promise<{ rowIds: string[]; rowCount: number }> {
    this.expiredCalls.push({ kgId: kindergartenId, now });
    const ids: string[] = [];
    for (const d of this.rows.values()) {
      if (
        d.kindergartenId === kindergartenId &&
        (d.status === 'active' || d.status === 'paused') &&
        d.validUntil !== null &&
        d.validUntil.getTime() <= now.getTime()
      ) {
        ids.push(d.id);
        this.rows.set(
          d.id,
          CustomDiscount.fromState({
            ...d.toState(),
            status: 'expired',
            updatedAt: now,
          }),
        );
      }
    }
    return Promise.resolve({ rowIds: ids, rowCount: ids.length });
  }

  acquireDiscountActivationAdvisoryLock(
    kindergartenId: string,
    id: string,
  ): Promise<void> {
    this.activationLockCalls.push({ kgId: kindergartenId, id });
    return Promise.resolve();
  }

  acquireDiscountApplyAdvisoryLock(
    _kindergartenId: string,
    _customDiscountId: string,
    _childId: string,
  ): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAppRepo extends CustomDiscountApplicationRepository {
  rows: CustomDiscountApplication[] = [];
  countByChildAndDiscountMap = new Map<string, number>();

  create(
    input: CreateCustomDiscountApplicationInput,
  ): Promise<CustomDiscountApplication> {
    const a = CustomDiscountApplication.fromState({
      id: randomUUID(),
      kindergartenId: input.kindergartenId,
      customDiscountId: input.customDiscountId,
      invoiceId: input.invoiceId,
      invoiceLineItemId: input.invoiceLineItemId,
      childId: input.childId,
      amountApplied: input.amountApplied,
      appliedAt: NOW,
    });
    this.rows.push(a);
    return Promise.resolve(a);
  }

  countByChildAndDiscount(
    kindergartenId: string,
    childId: string,
    customDiscountId: string,
  ): Promise<number> {
    const key = `${kindergartenId}|${childId}|${customDiscountId}`;
    if (this.countByChildAndDiscountMap.has(key)) {
      return Promise.resolve(
        this.countByChildAndDiscountMap.get(key) as number,
      );
    }
    return Promise.resolve(
      this.rows.filter(
        (r) =>
          r.kindergartenId === kindergartenId &&
          r.childId === childId &&
          r.customDiscountId === customDiscountId,
      ).length,
    );
  }

  listByDiscountId(
    kindergartenId: string,
    customDiscountId: string,
    pagination: CustomDiscountPageRequest,
  ): Promise<{ rows: CustomDiscountApplication[]; total: number }> {
    const matched = this.rows.filter(
      (r) =>
        r.kindergartenId === kindergartenId &&
        r.customDiscountId === customDiscountId,
    );
    return Promise.resolve({
      rows: matched.slice(
        pagination.offset,
        pagination.offset + pagination.limit,
      ),
      total: matched.length,
    });
  }

  getStatsForDiscount(
    kindergartenId: string,
    customDiscountId: string,
  ): Promise<CustomDiscountApplicationStats> {
    const matched = this.rows.filter(
      (r) =>
        r.kindergartenId === kindergartenId &&
        r.customDiscountId === customDiscountId,
    );
    return Promise.resolve({
      count: matched.length,
      totalAmountApplied: matched.reduce((s, r) => s + r.amountApplied, 0),
    });
  }
}

class FakeTargetResolver {
  resolveCalls: Array<{ kgId: string; id: string }> = [];
  resolveMap = new Map<string, Set<string>>();

  resolveTargetChildIds(
    kindergartenId: string,
    discount: CustomDiscount,
  ): Promise<Set<string>> {
    this.resolveCalls.push({ kgId: kindergartenId, id: discount.id });
    return Promise.resolve(this.resolveMap.get(discount.id) ?? new Set());
  }

  filterDiscountsForChild(
    _kindergartenId: string,
    _childId: string,
    snapshots: never[],
  ): Promise<never[]> {
    return Promise.resolve(snapshots);
  }
}

function buildSvc(): {
  svc: CustomDiscountService;
  repo: FakeCustomDiscountRepo;
  appRepo: FakeAppRepo;
  notif: InMemoryNotificationAdapter;
  resolver: FakeTargetResolver;
} {
  const repo = new FakeCustomDiscountRepo();
  const appRepo = new FakeAppRepo();
  const notif = new InMemoryNotificationAdapter();
  const resolver = new FakeTargetResolver();
  const svc = new CustomDiscountService(
    repo,
    appRepo,
    notif,
    new FakeDataSource() as unknown as DataSource,
    resolver as unknown as DiscountTargetResolver,
    new FakeClock(NOW),
  );
  return { svc, repo, appRepo, notif, resolver };
}

const VALID_INPUT = {
  name: { ru: 'Скидка А', kk: 'Жеңілдік А' },
  description: { ru: 'Описание' },
  discountType: 'percentage' as const,
  amount: 10,
  conditions: {} as const,
  targetType: 'all' as const,
  targetIds: null,
  validFrom: VALID_FROM,
  validUntil: VALID_UNTIL,
  maxUsesPerChild: null,
  totalMaxUses: null,
  priority: 100,
  stackable: false,
  notifyOnActivation: true,
  notificationTitle: { ru: 'Новая скидка' },
  notificationBody: { ru: 'Скидка доступна' },
};

describe('CustomDiscountService', () => {
  describe('create', () => {
    it('returns a draft CustomDiscount with all input fields persisted', async () => {
      const { svc } = buildSvc();
      const d = await svc.create(KG, VALID_INPUT, 'staff-1');
      expect(d.status).toBe('draft');
      expect(d.kindergartenId).toBe(KG);
      expect(d.amount).toBe(10);
      expect(d.discountType).toBe('percentage');
      expect(d.usedCount).toBe(0);
    });

    it('throws CustomDiscountConditionsInvalidError when conditions schema is malformed', async () => {
      const { svc } = buildSvc();
      await expect(
        svc.create(
          KG,
          {
            ...VALID_INPUT,
            conditions: {
              type: 'unknown_leaf_type_xyz',
            } as unknown as Record<string, never>,
          },
          'staff-1',
        ),
      ).rejects.toThrow(CustomDiscountConditionsInvalidError);
    });
  });

  describe('update', () => {
    it('returns the patched discount when status=draft', async () => {
      const { svc } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      const updated = await svc.update(KG, created.id, { amount: 20 });
      expect(updated.amount).toBe(20);
    });

    it('throws CustomDiscountStatusInvalidError when status != draft', async () => {
      const { svc, repo } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      // Manually flip into active to skip resolver wiring in this assertion.
      repo.put(
        CustomDiscount.fromState({
          ...created.toState(),
          status: 'active',
        }),
      );
      await expect(svc.update(KG, created.id, { amount: 20 })).rejects.toThrow(
        CustomDiscountStatusInvalidError,
      );
    });

    it('throws CustomDiscountNotFoundError on unknown id', async () => {
      const { svc } = buildSvc();
      await expect(
        svc.update(KG, '00000000-0000-0000-0000-000000000000', { amount: 20 }),
      ).rejects.toThrow(CustomDiscountNotFoundError);
    });
  });

  describe('activate', () => {
    it('transitions draft → active and emits discount.activated when notify is on', async () => {
      const { svc, repo, notif, resolver } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      resolver.resolveMap.set(created.id, new Set(['child-1', 'child-2']));
      const activated = await svc.activate(KG, created.id);
      expect(activated.status).toBe('active');
      expect(repo.activationLockCalls).toHaveLength(1);
      const events = notif.events.filter(
        (e) => e.type === 'discount_activated',
      );
      expect(events).toHaveLength(1);
      const evt = events[0].event as { targetChildIds: string[] };
      expect(new Set(evt.targetChildIds)).toEqual(
        new Set(['child-1', 'child-2']),
      );
    });

    it('skips notification emit when target set is empty', async () => {
      const { svc, notif } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      // resolver returns empty Set by default.
      await svc.activate(KG, created.id);
      const events = notif.events.filter(
        (e) => e.type === 'discount_activated',
      );
      expect(events).toHaveLength(0);
    });

    it('does not emit when notifyOnActivation=false', async () => {
      const { svc, notif, resolver } = buildSvc();
      const created = await svc.create(
        KG,
        { ...VALID_INPUT, notifyOnActivation: false },
        'staff-1',
      );
      resolver.resolveMap.set(created.id, new Set(['child-1']));
      await svc.activate(KG, created.id);
      const events = notif.events.filter(
        (e) => e.type === 'discount_activated',
      );
      expect(events).toHaveLength(0);
    });

    it('throws CustomDiscountStatusInvalidError when discount is already active', async () => {
      const { svc, repo } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      repo.put(
        CustomDiscount.fromState({ ...created.toState(), status: 'active' }),
      );
      await expect(svc.activate(KG, created.id)).rejects.toThrow(
        CustomDiscountStatusInvalidError,
      );
    });

    it('throws CustomDiscountNotFoundError on cross-tenant id', async () => {
      const { svc } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      await expect(svc.activate(KG_OTHER, created.id)).rejects.toThrow(
        CustomDiscountNotFoundError,
      );
    });
  });

  describe('pause / resume / cancel', () => {
    it('pause flips active → paused', async () => {
      const { svc, repo } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      repo.put(
        CustomDiscount.fromState({ ...created.toState(), status: 'active' }),
      );
      const paused = await svc.pause(KG, created.id);
      expect(paused.status).toBe('paused');
    });

    it('pause throws when status != active', async () => {
      const { svc } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      await expect(svc.pause(KG, created.id)).rejects.toThrow(
        CustomDiscountStatusInvalidError,
      );
    });

    it('resume flips paused → active', async () => {
      const { svc, repo } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      repo.put(
        CustomDiscount.fromState({ ...created.toState(), status: 'paused' }),
      );
      const resumed = await svc.resume(KG, created.id);
      expect(resumed.status).toBe('active');
    });

    it('cancel from draft → cancelled', async () => {
      const { svc } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      const cancelled = await svc.cancel(KG, created.id);
      expect(cancelled.status).toBe('cancelled');
    });

    it('cancel from active → cancelled', async () => {
      const { svc, repo } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      repo.put(
        CustomDiscount.fromState({ ...created.toState(), status: 'active' }),
      );
      const cancelled = await svc.cancel(KG, created.id);
      expect(cancelled.status).toBe('cancelled');
    });

    it('cancel throws when status=expired (terminal)', async () => {
      const { svc, repo } = buildSvc();
      const created = await svc.create(KG, VALID_INPUT, 'staff-1');
      repo.put(
        CustomDiscount.fromState({ ...created.toState(), status: 'expired' }),
      );
      await expect(svc.cancel(KG, created.id)).rejects.toThrow(
        CustomDiscountStatusInvalidError,
      );
    });

    it('cancel throws CustomDiscountNotFoundError on unknown id', async () => {
      const { svc } = buildSvc();
      await expect(
        svc.cancel(KG, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(CustomDiscountNotFoundError);
    });
  });

  describe('expireOverdue', () => {
    it('returns expired ids and silently flips active rows whose validity has passed', async () => {
      const { svc, repo, notif } = buildSvc();
      // validFrom must be < validUntil per aggregate invariant; we pick
      // a window that's strictly past relative to NOW.
      const created = await svc.create(
        KG,
        {
          ...VALID_INPUT,
          validFrom: new Date('2026-04-01T00:00:00.000Z'),
          validUntil: new Date('2026-05-01T00:00:00.000Z'),
        },
        'staff-1',
      );
      repo.put(
        CustomDiscount.fromState({ ...created.toState(), status: 'active' }),
      );
      const result = await svc.expireOverdue(KG, NOW);
      expect(result.expiredIds).toContain(created.id);
      // BP §4.1 silent: no discount.activated emit on expire.
      expect(
        notif.events.filter((e) => e.type === 'discount_activated'),
      ).toHaveLength(0);
    });

    it('returns empty when no overdue rows exist', async () => {
      const { svc } = buildSvc();
      const result = await svc.expireOverdue(KG, NOW);
      expect(result.expiredIds).toEqual([]);
    });

    it('expires a paused discount whose valid_until has passed', async () => {
      const { svc, repo } = buildSvc();
      const created = await svc.create(
        KG,
        {
          ...VALID_INPUT,
          validFrom: new Date('2026-04-01T00:00:00.000Z'),
          validUntil: new Date('2026-05-01T00:00:00.000Z'),
        },
        'staff-1',
      );
      repo.put(
        CustomDiscount.fromState({ ...created.toState(), status: 'paused' }),
      );
      const result = await svc.expireOverdue(KG, NOW);
      expect(result.expiredIds).toContain(created.id);
    });
  });

  describe('list / getById / listApplications', () => {
    it('list returns kg-scoped rows with total', async () => {
      const { svc } = buildSvc();
      await svc.create(KG, VALID_INPUT, 'staff-1');
      await svc.create(KG, VALID_INPUT, 'staff-1');
      await svc.create(KG_OTHER, VALID_INPUT, 'staff-1');
      const result = await svc.list(KG, {}, { limit: 10, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.rows.every((d) => d.kindergartenId === KG)).toBe(true);
    });

    // T8 M2 — target_type filter wired through repo.
    it('list filters by targetType when supplied', async () => {
      const { svc } = buildSvc();
      await svc.create(KG, { ...VALID_INPUT, targetType: 'all' }, 'staff-1');
      await svc.create(
        KG,
        {
          ...VALID_INPUT,
          targetType: 'children',
          targetIds: ['00000000-0000-0000-0000-000000000111'],
        },
        'staff-1',
      );
      const allOnly = await svc.list(
        KG,
        { targetType: 'all' },
        { limit: 10, offset: 0 },
      );
      expect(allOnly.total).toBe(1);
      expect(allOnly.rows[0].targetType).toBe('all');
      const childrenOnly = await svc.list(
        KG,
        { targetType: 'children' },
        { limit: 10, offset: 0 },
      );
      expect(childrenOnly.total).toBe(1);
      expect(childrenOnly.rows[0].targetType).toBe('children');
    });

    it('getById returns the discount + stats', async () => {
      const { svc, appRepo } = buildSvc();
      const d = await svc.create(KG, VALID_INPUT, 'staff-1');
      await appRepo.create({
        kindergartenId: KG,
        customDiscountId: d.id,
        invoiceId: 'inv-1',
        invoiceLineItemId: null,
        childId: 'child-1',
        amountApplied: 5000,
      });
      const result = await svc.getById(KG, d.id);
      expect(result.discount.id).toBe(d.id);
      expect(result.stats.count).toBe(1);
      expect(result.stats.totalAmountApplied).toBe(5000);
    });

    it('getById throws CustomDiscountNotFoundError on unknown id', async () => {
      const { svc } = buildSvc();
      await expect(
        svc.getById(KG, '00000000-0000-0000-0000-000000000000'),
      ).rejects.toThrow(CustomDiscountNotFoundError);
    });

    it('listApplications returns paginated rows and throws when discount unknown', async () => {
      const { svc } = buildSvc();
      const d = await svc.create(KG, VALID_INPUT, 'staff-1');
      const result = await svc.listApplications(KG, d.id, {
        limit: 10,
        offset: 0,
      });
      expect(result.total).toBe(0);
      await expect(
        svc.listApplications(KG, '00000000-0000-0000-0000-000000000000', {
          limit: 10,
          offset: 0,
        }),
      ).rejects.toThrow(CustomDiscountNotFoundError);
    });
  });
});
