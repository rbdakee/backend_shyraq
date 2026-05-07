import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { KindergartenHoliday } from './domain/entities/kindergarten-holiday.entity';
import { KindergartenHolidayAlreadyExistsError } from './domain/errors/kindergarten-holiday-already-exists.error';
import {
  CreateKindergartenHolidayInput,
  KindergartenHolidayRepository,
  ListKindergartenHolidaysFilter,
  UpdateKindergartenHolidayPatch,
} from './infrastructure/persistence/kindergarten-holiday.repository';
import { HolidayService } from './holiday.service';
import { NotFoundError } from '@/shared-kernel/domain/errors';

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

class FakeHolidayRepo extends KindergartenHolidayRepository {
  rows = new Map<string, KindergartenHoliday>();
  private nextId = 0;

  put(h: KindergartenHoliday): void {
    this.rows.set(h.id, h);
  }

  create(input: CreateKindergartenHolidayInput): Promise<KindergartenHoliday> {
    const dateMs = input.date.getTime();
    for (const h of this.rows.values()) {
      if (
        h.kindergartenId === input.kindergartenId &&
        h.date.getTime() === dateMs
      ) {
        return Promise.reject(
          new KindergartenHolidayAlreadyExistsError(
            input.kindergartenId,
            input.date.toISOString().slice(0, 10),
          ),
        );
      }
    }
    const id = `h-${++this.nextId}`;
    const h = KindergartenHoliday.fromState({
      id,
      kindergartenId: input.kindergartenId,
      date: input.date,
      name: input.name,
      isBillable: input.isBillable,
      createdAt: NOW,
      updatedAt: NOW,
    });
    this.rows.set(id, h);
    return Promise.resolve(h);
  }

  update(
    kindergartenId: string,
    id: string,
    patch: UpdateKindergartenHolidayPatch,
    now: Date,
  ): Promise<KindergartenHoliday | null> {
    const existing = this.rows.get(id);
    if (!existing || existing.kindergartenId !== kindergartenId) {
      return Promise.resolve(null);
    }
    const s = existing.toState();
    const next = KindergartenHoliday.fromState({
      ...s,
      date: patch.date ?? s.date,
      name: patch.name ?? s.name,
      isBillable:
        patch.isBillable !== undefined ? patch.isBillable : s.isBillable,
      updatedAt: now,
    });
    this.rows.set(id, next);
    return Promise.resolve(next);
  }

  delete(kindergartenId: string, id: string): Promise<void> {
    const existing = this.rows.get(id);
    if (existing && existing.kindergartenId === kindergartenId) {
      this.rows.delete(id);
    }
    return Promise.resolve();
  }

  findById(
    kindergartenId: string,
    id: string,
  ): Promise<KindergartenHoliday | null> {
    const h = this.rows.get(id);
    if (!h || h.kindergartenId !== kindergartenId) return Promise.resolve(null);
    return Promise.resolve(h);
  }

  list(
    kindergartenId: string,
    filter: ListKindergartenHolidaysFilter = {},
  ): Promise<KindergartenHoliday[]> {
    const out = [...this.rows.values()].filter((h) => {
      if (h.kindergartenId !== kindergartenId) return false;
      if (
        filter.fromDate &&
        h.date.toISOString().slice(0, 10) < filter.fromDate
      ) {
        return false;
      }
      if (filter.toDate && h.date.toISOString().slice(0, 10) > filter.toDate) {
        return false;
      }
      if (
        filter.isBillable !== undefined &&
        h.isBillable !== filter.isBillable
      ) {
        return false;
      }
      return true;
    });
    return Promise.resolve(out);
  }

  countNonBillableInRange(
    kindergartenId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<number> {
    let count = 0;
    for (const h of this.rows.values()) {
      if (h.kindergartenId !== kindergartenId) continue;
      if (h.isBillable) continue;
      if (
        h.date.getTime() >= periodStart.getTime() &&
        h.date.getTime() <= periodEnd.getTime()
      ) {
        count++;
      }
    }
    return Promise.resolve(count);
  }
}

describe('HolidayService', () => {
  let repo: FakeHolidayRepo;
  let svc: HolidayService;

  beforeEach(() => {
    repo = new FakeHolidayRepo();
    svc = new HolidayService(repo, new FakeClock(NOW));
  });

  describe('create', () => {
    it('returns a persisted holiday', async () => {
      const h = await svc.create(KG, {
        date: new Date('2026-05-09T00:00:00.000Z'),
        name: { ru: 'День Победы' },
      });
      expect(h.kindergartenId).toBe(KG);
      expect(h.isBillable).toBe(false);
    });

    it('throws KindergartenHolidayAlreadyExistsError on duplicate date', async () => {
      const date = new Date('2026-05-09T00:00:00.000Z');
      await svc.create(KG, { date, name: { ru: 'A' } });
      await expect(svc.create(KG, { date, name: { ru: 'B' } })).rejects.toThrow(
        KindergartenHolidayAlreadyExistsError,
      );
    });
  });

  describe('update', () => {
    it('returns the patched holiday', async () => {
      const h = await svc.create(KG, {
        date: new Date('2026-05-09T00:00:00.000Z'),
        name: { ru: 'A' },
      });
      const updated = await svc.update(KG, h.id, { isBillable: true });
      expect(updated.isBillable).toBe(true);
    });

    it('throws NotFoundError for unknown id', async () => {
      await expect(
        svc.update(KG, 'missing', { isBillable: true }),
      ).rejects.toThrow(NotFoundError);
    });
  });

  describe('delete', () => {
    it('removes the row when found', async () => {
      const h = await svc.create(KG, {
        date: new Date('2026-05-09T00:00:00.000Z'),
        name: { ru: 'A' },
      });
      await svc.delete(KG, h.id);
      expect(repo.rows.size).toBe(0);
    });

    it('throws NotFoundError for unknown id', async () => {
      await expect(svc.delete(KG, 'missing')).rejects.toThrow(NotFoundError);
    });
  });

  describe('list / get / countNonBillableInRange', () => {
    it('list returns kg-scoped rows', async () => {
      await svc.create(KG, {
        date: new Date('2026-05-09T00:00:00.000Z'),
        name: { ru: 'A' },
      });
      const list = await svc.list(KG);
      expect(list).toHaveLength(1);
    });

    it('get throws NotFoundError for unknown id', async () => {
      await expect(svc.get(KG, 'missing')).rejects.toThrow(NotFoundError);
    });

    it('countNonBillableInRange counts only non-billable days', async () => {
      await svc.create(KG, {
        date: new Date('2026-05-09T00:00:00.000Z'),
        name: { ru: 'A' },
        isBillable: false,
      });
      await svc.create(KG, {
        date: new Date('2026-05-10T00:00:00.000Z'),
        name: { ru: 'B' },
        isBillable: true,
      });
      const count = await svc.countNonBillableInRange(
        KG,
        new Date('2026-05-01T00:00:00.000Z'),
        new Date('2026-05-31T00:00:00.000Z'),
      );
      expect(count).toBe(1);
    });
  });
});
