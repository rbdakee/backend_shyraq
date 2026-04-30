/**
 * WeeklyRolloutService — service-unit suite. All collaborators are
 * hand-written in-memory fakes (no Jest auto-mock, no DB, no NestJS
 * runtime). Exercises:
 *   - directory scan iterates every active kindergarten
 *   - per-kg `SET LOCAL app.kindergarten_id` + tenantStorage hand-off
 *   - aggregation of schedule + meal counters into totals
 *   - one-kg failure does NOT abort the batch
 *   - idempotency — re-running with the same fromMonday produces the same
 *     totals (skipped instead of copied) when the fakes already saw the run
 */
import { Kindergarten } from '@/modules/kindergarten/domain/entities/kindergarten.entity';
import {
  KindergartenCreateInput,
  KindergartenFilters,
  KindergartenListResult,
  KindergartenRepository,
  KindergartenUpdateInput,
} from '@/modules/kindergarten/infrastructure/persistence/kindergarten.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { WeeklyRolloutService } from './weekly-rollout.service';

// ── Fakes ───────────────────────────────────────────────────────────────

const KG_A = '11111111-1111-1111-1111-111111111111';
const KG_B = '22222222-2222-2222-2222-222222222222';
const KG_C = '33333333-3333-3333-3333-333333333333';
const NOW = new Date('2026-05-03T18:00:00.000Z'); // Sun Almaty 23:00

class FixedClock extends ClockPort {
  constructor(private readonly t: Date) {
    super();
  }
  now(): Date {
    return this.t;
  }
}

class FakeKindergartenRepository extends KindergartenRepository {
  rows: Kindergarten[] = [];

  putActive(id: string, name = `KG-${id}`): void {
    this.rows.push(
      Kindergarten.hydrate({
        id,
        name,
        slug: name.toLowerCase(),
        address: null,
        phone: null,
        plan: 'basic',
        settings: {},
        isActive: true,
        archivedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  putArchived(id: string, name = `KG-${id}`): void {
    const archivedAt = new Date(NOW.getTime() - 1000);
    this.rows.push(
      Kindergarten.hydrate({
        id,
        name,
        slug: name.toLowerCase(),
        address: null,
        phone: null,
        plan: 'basic',
        settings: {},
        isActive: false,
        archivedAt,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    );
  }

  create(_input: KindergartenCreateInput): Promise<Kindergarten> {
    throw new Error('not implemented');
  }
  findById(id: string): Promise<Kindergarten | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
  findBySlug(slug: string): Promise<Kindergarten | null> {
    return Promise.resolve(this.rows.find((r) => r.slug === slug) ?? null);
  }
  findAll(_filters: KindergartenFilters): Promise<KindergartenListResult> {
    return Promise.resolve({
      items: this.rows,
      total: this.rows.length,
      limit: 50,
      offset: 0,
    });
  }
  listActive(): Promise<Kindergarten[]> {
    return Promise.resolve(
      this.rows.filter((r) => r.isActive && !r.isArchived),
    );
  }
  update(
    _id: string,
    _changes: KindergartenUpdateInput,
  ): Promise<Kindergarten> {
    throw new Error('not implemented');
  }
}

class FakeScheduleService {
  /**
   * Tracks (kgId, fromMondayIso) so re-runs of the same week observe an
   * idempotent skip on the second call.
   */
  seenWeeks = new Set<string>();
  shouldThrowFor: string | null = null;

  copyWeekToNext(
    kgId: string,
    fromMonday: Date,
    _source: 'manual' | 'cron',
  ): Promise<{
    copiedGroups: number;
    skippedGroups: number;
    totalEvents: number;
    snapshots: unknown[];
  }> {
    if (this.shouldThrowFor === kgId) {
      return Promise.reject(new Error('schedule_failure'));
    }
    const key = `${kgId}|${fromMonday.toISOString().slice(0, 10)}`;
    if (this.seenWeeks.has(key)) {
      return Promise.resolve({
        copiedGroups: 0,
        skippedGroups: 2,
        totalEvents: 0,
        snapshots: [],
      });
    }
    this.seenWeeks.add(key);
    return Promise.resolve({
      copiedGroups: 2,
      skippedGroups: 0,
      totalEvents: 12,
      snapshots: [],
    });
  }
}

class FakeMealService {
  seenWeeks = new Set<string>();

  copyWeekMenuToNext(
    kgId: string,
    fromMonday: Date,
    _source: 'manual' | 'cron',
  ): Promise<{ plans_created: number; plans_skipped: number }> {
    const key = `${kgId}|${fromMonday.toISOString().slice(0, 10)}`;
    if (this.seenWeeks.has(key)) {
      return Promise.resolve({ plans_created: 0, plans_skipped: 5 });
    }
    this.seenWeeks.add(key);
    return Promise.resolve({ plans_created: 5, plans_skipped: 0 });
  }
}

/**
 * Minimal DataSource fake — only `transaction(cb)` is exercised. The
 * service uses it to scope the bypass-rls directory scan and per-kg
 * `SET LOCAL`. The fake collects every `manager.query` call so the test
 * can assert the GUC dance.
 */
class FakeDataSource {
  queries: string[] = [];

  transaction<T>(cb: (manager: unknown) => Promise<T>): Promise<T> {
    const manager = {
      query: (q: string): Promise<unknown[]> => {
        this.queries.push(q);
        return Promise.resolve([]);
      },
    };
    return cb(manager);
  }
}

function makeService(): {
  service: WeeklyRolloutService;
  kgRepo: FakeKindergartenRepository;
  scheduleSvc: FakeScheduleService;
  mealSvc: FakeMealService;
  dataSource: FakeDataSource;
} {
  const kgRepo = new FakeKindergartenRepository();
  const scheduleSvc = new FakeScheduleService();
  const mealSvc = new FakeMealService();
  const dataSource = new FakeDataSource();
  const service = new WeeklyRolloutService(
    scheduleSvc as unknown as ConstructorParameters<
      typeof WeeklyRolloutService
    >[0],
    mealSvc as unknown as ConstructorParameters<typeof WeeklyRolloutService>[1],
    kgRepo,
    new FixedClock(NOW),
    dataSource as unknown as ConstructorParameters<
      typeof WeeklyRolloutService
    >[4],
  );
  return { service, kgRepo, scheduleSvc, mealSvc, dataSource };
}

// ── Specs ───────────────────────────────────────────────────────────────

describe('WeeklyRolloutService.runWeeklyRollout', () => {
  const fromMonday = new Date('2026-04-27T00:00:00.000Z');

  it('iterates every active kindergarten and aggregates totals', async () => {
    const { service, kgRepo } = makeService();
    kgRepo.putActive(KG_A);
    kgRepo.putActive(KG_B);
    kgRepo.putArchived(KG_C);

    const summary = await service.runWeeklyRollout({
      fromMonday,
      source: 'manual',
    });

    expect(summary.fromMonday).toBe('2026-04-27');
    expect(summary.source).toBe('manual');
    expect(summary.kindergartens).toHaveLength(2);
    expect(summary.kindergartens.map((k) => k.kindergartenId).sort()).toEqual(
      [KG_A, KG_B].sort(),
    );
    expect(summary.totals).toEqual({
      kindergartens: 2,
      copiedGroups: 4, // 2 per kg
      skippedGroups: 0,
      totalEvents: 24, // 12 per kg
      plansCreated: 10, // 5 per kg
      plansSkipped: 0,
      errors: 0,
    });
  });

  it('issues SET LOCAL app.kindergarten_id per kg + bypass_rls for the directory scan', async () => {
    const { service, kgRepo, dataSource } = makeService();
    kgRepo.putActive(KG_A);
    kgRepo.putActive(KG_B);

    await service.runWeeklyRollout({ fromMonday, source: 'manual' });

    // First query: bypass_rls for the directory scan.
    expect(dataSource.queries[0]).toMatch(/SET LOCAL app\.bypass_rls = 'true'/);
    // Then one SET LOCAL per kg.
    const setLocals = dataSource.queries.filter((q) =>
      q.startsWith('SET LOCAL app.kindergarten_id'),
    );
    expect(setLocals).toHaveLength(2);
    expect(setLocals[0]).toContain(KG_A);
    expect(setLocals[1]).toContain(KG_B);
  });

  it('captures one-kg failure into the summary and continues with the rest', async () => {
    const { service, kgRepo, scheduleSvc } = makeService();
    kgRepo.putActive(KG_A);
    kgRepo.putActive(KG_B);
    scheduleSvc.shouldThrowFor = KG_A;

    const summary = await service.runWeeklyRollout({
      fromMonday,
      source: 'cron',
    });

    expect(summary.kindergartens).toHaveLength(2);
    const itemA = summary.kindergartens.find((k) => k.kindergartenId === KG_A)!;
    const itemB = summary.kindergartens.find((k) => k.kindergartenId === KG_B)!;
    expect(itemA.error).toBe('schedule_failure');
    expect(itemA.schedule.copiedGroups).toBe(0);
    expect(itemB.error).toBeNull();
    expect(itemB.schedule.copiedGroups).toBe(2);
    expect(summary.totals.errors).toBe(1);
    expect(summary.totals.copiedGroups).toBe(2); // only KG_B counted
  });

  it('idempotent: re-running with the same fromMonday returns skipped totals', async () => {
    const { service, kgRepo } = makeService();
    kgRepo.putActive(KG_A);
    kgRepo.putActive(KG_B);

    const first = await service.runWeeklyRollout({
      fromMonday,
      source: 'manual',
    });
    const second = await service.runWeeklyRollout({
      fromMonday,
      source: 'manual',
    });

    expect(first.totals.copiedGroups).toBe(4);
    expect(first.totals.skippedGroups).toBe(0);
    expect(second.totals.copiedGroups).toBe(0);
    expect(second.totals.skippedGroups).toBe(4); // 2 per kg, 'skipped'
    expect(second.totals.plansCreated).toBe(0);
    expect(second.totals.plansSkipped).toBe(10);
    expect(second.totals.errors).toBe(0);
  });

  it('rejects malformed kg ids without aborting the batch', async () => {
    const { service, kgRepo } = makeService();
    kgRepo.putActive('not-a-uuid'); // malformed
    kgRepo.putActive(KG_B);

    const summary = await service.runWeeklyRollout({
      fromMonday,
      source: 'cron',
    });

    expect(summary.kindergartens).toHaveLength(2);
    const bad = summary.kindergartens.find(
      (k) => k.kindergartenId === 'not-a-uuid',
    )!;
    expect(bad.error).toBe('malformed_kindergarten_id');
    expect(summary.totals.errors).toBe(1);
    expect(summary.totals.copiedGroups).toBe(2); // KG_B only
  });

  it('returns an empty summary when no active kindergartens exist', async () => {
    const { service } = makeService();
    const summary = await service.runWeeklyRollout({
      fromMonday,
      source: 'cron',
    });
    expect(summary.kindergartens).toEqual([]);
    expect(summary.totals.kindergartens).toBe(0);
    expect(summary.totals.errors).toBe(0);
  });
});

describe('WeeklyRolloutService.computePreviousMonday', () => {
  it("snaps Sun 23:00 Almaty to that ISO week's Monday (the week just ending)", () => {
    const { service } = makeService();
    // Sun 2026-05-03 18:00 UTC = Sun 23:00 Almaty (the cron tick).
    // ISO week of 2026-05-03 starts Mon 2026-04-27 — that's the source-week
    // Monday the cron uses to project onto the next week.
    const tick = new Date('2026-05-03T18:00:00.000Z');
    expect(service.computePreviousMonday(tick).toISOString().slice(0, 10)).toBe(
      '2026-04-27',
    );
  });

  it('returns the source-week Monday at 00:00 UTC', () => {
    const { service } = makeService();
    const tick = new Date('2026-05-03T18:00:00.000Z');
    const prev = service.computePreviousMonday(tick);
    expect(prev.getUTCHours()).toBe(0);
    expect(prev.getUTCMinutes()).toBe(0);
  });

  it("Tuesday morning UTC snaps to the current Almaty week's Monday", () => {
    const { service } = makeService();
    // Tue 2026-05-05 03:00 UTC = Tue 08:00 Almaty (current Almaty week
    // starts Mon 2026-05-04). Manual operator runs are idempotent, so the
    // source-week Monday is always the Almaty Monday the operator's
    // already lived through.
    const tick = new Date('2026-05-05T03:00:00.000Z');
    expect(service.computePreviousMonday(tick).toISOString().slice(0, 10)).toBe(
      '2026-05-04',
    );
  });

  it('crosses the year boundary correctly', () => {
    const { service } = makeService();
    // Sun 2026-01-04 18:00 UTC = Sun 23:00 Almaty.
    // ISO week of 2026-01-04 starts Mon 2025-12-29.
    const tick = new Date('2026-01-04T18:00:00.000Z');
    expect(service.computePreviousMonday(tick).toISOString().slice(0, 10)).toBe(
      '2025-12-29',
    );
  });
});
