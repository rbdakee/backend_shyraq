import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { AuditService } from './audit.service';
import {
  AuditEntityType,
  AuditLogEntry,
} from './domain/entities/audit-log-entry.entity';
import {
  AuditLogRepository,
  ListAuditLogByEntityOptions,
} from './infrastructure/persistence/audit-log.repository';

const KG = 'kg-1';
const KG_OTHER = 'kg-2';
const EVENT_ID = 'event-1';
const NOW = new Date('2026-07-15T10:00:00.000Z');

class MutableClock extends ClockPort {
  constructor(private current: Date = NOW) {
    super();
  }
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/**
 * In-memory stand-in for the relational repo. Mirrors the two behaviours the
 * service depends on: tenant scoping and created_at DESC ordering (with an
 * insertion-order tiebreak standing in for the SQL `id DESC` tiebreak).
 */
class FakeAuditLogRepository extends AuditLogRepository {
  rows: AuditLogEntry[] = [];

  create(kindergartenId: string, entry: AuditLogEntry): Promise<AuditLogEntry> {
    if (entry.kindergartenId !== kindergartenId) {
      throw new Error('audit_log_tenant_mismatch');
    }
    this.rows.push(entry);
    return Promise.resolve(entry);
  }

  listByEntity(
    kindergartenId: string,
    entityType: AuditEntityType,
    entityId: string,
    opts: ListAuditLogByEntityOptions,
  ): Promise<AuditLogEntry[]> {
    const matched = this.rows
      .map((row, index) => ({ row, index }))
      .filter(
        ({ row }) =>
          row.kindergartenId === kindergartenId &&
          row.entityType === entityType &&
          row.entityId === entityId,
      )
      .sort((a, b) => {
        const byTime = b.row.createdAt.getTime() - a.row.createdAt.getTime();
        return byTime !== 0 ? byTime : b.index - a.index;
      })
      .map(({ row }) => row);
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? matched.length;
    return Promise.resolve(matched.slice(offset, offset + limit));
  }
}

describe('AuditService', () => {
  let repo: FakeAuditLogRepository;
  let clock: MutableClock;
  let service: AuditService;

  beforeEach(() => {
    repo = new FakeAuditLogRepository();
    clock = new MutableClock();
    service = new AuditService(repo, clock);
  });

  describe('record', () => {
    it('returns the persisted entry with a generated id and clock timestamp', async () => {
      const entry = await service.record({
        kindergartenId: KG,
        entityType: 'attendance_event',
        entityId: EVENT_ID,
        action: 'update',
        actorStaffId: 'staff-1',
        before: { notes: 'old' },
        after: { notes: 'new' },
      });

      expect(entry.id).toEqual(expect.any(String));
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.createdAt).toEqual(NOW);
      expect(entry.kindergartenId).toBe(KG);
      expect(entry.entityType).toBe('attendance_event');
      expect(entry.entityId).toBe(EVENT_ID);
      expect(entry.action).toBe('update');
      expect(entry.actorStaffId).toBe('staff-1');
      expect(entry.before).toEqual({ notes: 'old' });
      expect(entry.after).toEqual({ notes: 'new' });
      expect(repo.rows).toHaveLength(1);
    });

    it('returns null actors and snapshots when the caller omits them', async () => {
      const entry = await service.record({
        kindergartenId: KG,
        entityType: 'child_daily_status',
        entityId: 'status-1',
        action: 'create',
      });

      expect(entry.actorUserId).toBeNull();
      expect(entry.actorStaffId).toBeNull();
      expect(entry.before).toBeNull();
      expect(entry.after).toBeNull();
    });

    it('returns a distinct id for every entry', async () => {
      const first = await service.record({
        kindergartenId: KG,
        entityType: 'attendance_event',
        entityId: EVENT_ID,
        action: 'create',
      });
      const second = await service.record({
        kindergartenId: KG,
        entityType: 'attendance_event',
        entityId: EVENT_ID,
        action: 'delete',
      });

      expect(first.id).not.toBe(second.id);
    });

    it('rejects when the repository write fails', async () => {
      jest
        .spyOn(repo, 'create')
        .mockRejectedValueOnce(new Error('audit_log_create_readback_failed'));

      await expect(
        service.record({
          kindergartenId: KG,
          entityType: 'attendance_event',
          entityId: EVENT_ID,
          action: 'create',
        }),
      ).rejects.toThrow('audit_log_create_readback_failed');
    });
  });

  describe('listByEntity', () => {
    it('returns entries for the entity newest first', async () => {
      await service.record({
        kindergartenId: KG,
        entityType: 'attendance_event',
        entityId: EVENT_ID,
        action: 'create',
      });
      clock.advance(60_000);
      await service.record({
        kindergartenId: KG,
        entityType: 'attendance_event',
        entityId: EVENT_ID,
        action: 'update',
      });
      clock.advance(60_000);
      await service.record({
        kindergartenId: KG,
        entityType: 'attendance_event',
        entityId: EVENT_ID,
        action: 'delete',
      });

      const entries = await service.listByEntity(
        KG,
        'attendance_event',
        EVENT_ID,
      );

      expect(entries.map((e) => e.action)).toEqual([
        'delete',
        'update',
        'create',
      ]);
    });

    it('returns an empty list when the entity has no history', async () => {
      const entries = await service.listByEntity(
        KG,
        'attendance_event',
        'nope',
      );
      expect(entries).toEqual([]);
    });

    it('returns only entries of the requested entity type', async () => {
      await service.record({
        kindergartenId: KG,
        entityType: 'attendance_event',
        entityId: EVENT_ID,
        action: 'create',
      });
      await service.record({
        kindergartenId: KG,
        entityType: 'child_daily_status',
        entityId: EVENT_ID,
        action: 'create',
      });

      const entries = await service.listByEntity(
        KG,
        'child_daily_status',
        EVENT_ID,
      );

      expect(entries).toHaveLength(1);
      expect(entries[0].entityType).toBe('child_daily_status');
    });

    it('returns no entries recorded by another kindergarten', async () => {
      await service.record({
        kindergartenId: KG_OTHER,
        entityType: 'attendance_event',
        entityId: EVENT_ID,
        action: 'create',
      });

      const entries = await service.listByEntity(
        KG,
        'attendance_event',
        EVENT_ID,
      );

      expect(entries).toEqual([]);
    });

    it('returns the requested page when limit and offset are given', async () => {
      for (const action of ['create', 'update', 'delete'] as const) {
        await service.record({
          kindergartenId: KG,
          entityType: 'attendance_event',
          entityId: EVENT_ID,
          action,
        });
        clock.advance(60_000);
      }

      const page = await service.listByEntity(
        KG,
        'attendance_event',
        EVENT_ID,
        {
          limit: 1,
          offset: 1,
        },
      );

      expect(page).toHaveLength(1);
      expect(page[0].action).toBe('update');
    });
  });
});
