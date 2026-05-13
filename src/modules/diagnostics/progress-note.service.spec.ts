import { randomUUID } from 'node:crypto';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { OptimisticLockError } from '@/shared-kernel/domain/errors';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ProgressNoteService } from './progress-note.service';
import {
  ListProgressNotesFilter,
  ProgressNoteListResult,
  ProgressNoteRepository,
} from './progress-note.repository';
import { ProgressNote } from './domain/entities/progress-note.entity';
import { ProgressNoteNotAuthoredByYouError } from './domain/errors/progress-note-not-authored-by-you.error';
import { ProgressNoteNotFoundError } from './domain/errors/progress-note-not-found.error';

const KG = '11111111-1111-1111-1111-111111111111';
const MENTOR_A = '22222222-2222-2222-2222-222222222222';
const MENTOR_B = '33333333-3333-3333-3333-333333333333';
const ADMIN = '44444444-4444-4444-4444-444444444444';
const CHILD = '55555555-5555-5555-5555-555555555555';
// B22a T7 — caller's `users.id` (separate from `staff_members.id`).
const USER_A = '99999999-9999-9999-9999-999999999991';
const USER_B = '99999999-9999-9999-9999-999999999992';
const ADMIN_USER = '99999999-9999-9999-9999-999999999993';
const NOW = new Date('2026-05-01T09:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private d: Date = NOW) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakeNoteRepo extends ProgressNoteRepository {
  rows = new Map<string, ProgressNote>();

  put(n: ProgressNote): void {
    this.rows.set(n.id, n);
  }
  create(n: ProgressNote): Promise<ProgressNote> {
    this.rows.set(n.id, n);
    return Promise.resolve(n);
  }
  findById(kgId: string, id: string): Promise<ProgressNote | null> {
    const n = this.rows.get(id);
    if (!n || n.kindergartenId !== kgId) return Promise.resolve(null);
    return Promise.resolve(n);
  }
  /**
   * In-memory mirror of the relational repo's optimistic-lock contract:
   * see `diagnostic-template.service.spec.ts` for the shared rationale.
   */
  update(n: ProgressNote, expectedRowVersion?: number): Promise<ProgressNote> {
    if (expectedRowVersion !== undefined) {
      const current = this.rows.get(n.id);
      if (!current || current.kindergartenId !== n.kindergartenId) {
        throw new OptimisticLockError();
      }
      if (current.rowVersion !== expectedRowVersion) {
        throw new OptimisticLockError();
      }
      const bumped = ProgressNote.rehydrate({
        ...n.toState(),
        rowVersion: current.rowVersion + 1,
      });
      this.rows.set(n.id, bumped);
      return Promise.resolve(bumped);
    }
    this.rows.set(n.id, n);
    return Promise.resolve(n);
  }
  delete(kgId: string, id: string): Promise<boolean> {
    const n = this.rows.get(id);
    if (!n || n.kindergartenId !== kgId) return Promise.resolve(false);
    this.rows.delete(id);
    return Promise.resolve(true);
  }
  list(
    kgId: string,
    filters: ListProgressNotesFilter,
  ): Promise<ProgressNoteListResult> {
    const items = Array.from(this.rows.values()).filter((n) => {
      if (n.kindergartenId !== kgId) return false;
      if (filters.childId !== undefined && n.childId !== filters.childId)
        return false;
      if (filters.mentorId !== undefined && n.mentorId !== filters.mentorId)
        return false;
      return true;
    });
    return Promise.resolve({ items, nextCursor: null });
  }
}

class FakeChildRepo {
  rows = new Map<string, { id: string; kgId: string }>();

  putActive(kgId: string, id: string): void {
    this.rows.set(`${kgId}:${id}`, { id, kgId });
  }

  findById(kgId: string, id: string): Promise<unknown> {
    const row = this.rows.get(`${kgId}:${id}`);
    return Promise.resolve(row ? { id: row.id } : null);
  }
}

function buildNote(
  overrides: Partial<{
    id: string;
    mentorId: string;
    body: string;
    rowVersion: number;
  }> = {},
): ProgressNote {
  return ProgressNote.fromState(
    {
      id: overrides.id ?? randomUUID(),
      kindergartenId: KG,
      childId: CHILD,
      mentorId: overrides.mentorId ?? MENTOR_A,
      body: overrides.body ?? 'Initial body',
      mediaUrls: [],
      notedAt: NOW,
      createdAt: NOW,
      rowVersion: overrides.rowVersion ?? 1,
    },
    NOW,
  );
}

describe('ProgressNoteService', () => {
  let repo: FakeNoteRepo;
  let children: FakeChildRepo;
  let notification: InMemoryNotificationAdapter;
  let service: ProgressNoteService;

  beforeEach(() => {
    repo = new FakeNoteRepo();
    children = new FakeChildRepo();
    children.putActive(KG, CHILD);
    notification = new InMemoryNotificationAdapter();
    service = new ProgressNoteService(
      repo,
      children as unknown as ChildRepository,
      notification,
      new FakeClock(),
    );
  });

  describe('create', () => {
    it('inserts a note and emits progress_note_new', async () => {
      const n = await service.create(KG, {
        childId: CHILD,
        mentorId: MENTOR_A,
        body: 'Made progress today',
      });
      expect(n.body).toBe('Made progress today');
      expect(notification.events).toHaveLength(1);
      expect(notification.events[0].type).toBe('progress_note_new');
      expect(notification.events[0].event).toMatchObject({
        kindergartenId: KG,
        childId: CHILD,
        noteId: n.id,
        mentorId: MENTOR_A,
      });
    });

    it('throws 404 when child does not belong to the kg (cross-tenant guard)', async () => {
      const foreignChildId = randomUUID();
      await expect(
        service.create(KG, {
          childId: foreignChildId,
          mentorId: MENTOR_A,
          body: 'Made progress today',
        }),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
      expect(notification.events).toHaveLength(0);
    });

    it('rejects empty body', async () => {
      await expect(
        service.create(KG, { childId: CHILD, mentorId: MENTOR_A, body: '   ' }),
      ).rejects.toMatchObject({ code: 'empty_body' });
      expect(notification.events).toHaveLength(0);
    });

    it('rejects notedAt > now+5min', async () => {
      const future = new Date(NOW.getTime() + 60 * 60 * 1000); // +1 hour
      await expect(
        service.create(KG, {
          childId: CHILD,
          mentorId: MENTOR_A,
          body: 'x',
          notedAt: future,
        }),
      ).rejects.toMatchObject({ code: 'noted_at_in_future' });
    });
  });

  describe('update', () => {
    it('PATCHes body for the author', async () => {
      const note = buildNote();
      repo.put(note);
      const updated = await service.update(KG, note.id, MENTOR_A, USER_A, {
        body: 'Edited',
      });
      expect(updated.body).toBe('Edited');
    });

    it('throws 403 when caller is not the author', async () => {
      const note = buildNote();
      repo.put(note);
      await expect(
        service.update(KG, note.id, MENTOR_B, USER_B, { body: 'x' }),
      ).rejects.toBeInstanceOf(ProgressNoteNotAuthoredByYouError);
    });

    it('throws 404 when note missing', async () => {
      await expect(
        service.update(KG, randomUUID(), MENTOR_A, USER_A, { body: 'x' }),
      ).rejects.toBeInstanceOf(ProgressNoteNotFoundError);
    });

    it('rejects empty body in patch', async () => {
      const note = buildNote();
      repo.put(note);
      await expect(
        service.update(KG, note.id, MENTOR_A, USER_A, { body: '' }),
      ).rejects.toMatchObject({ code: 'empty_body' });
    });

    it('throws OptimisticLockError when repo signals stale row_version', async () => {
      // Race-protection regression (B22a T4 / B18 T6-M4): the service
      // must surface the repo's `OptimisticLockError` so DomainErrorFilter
      // maps it to 409 `optimistic_lock_conflict`. We simulate the
      // race by patching `findById` to return a stale snapshot while
      // the underlying store has already advanced — exactly the
      // SELECT-then-UPDATE window the optimistic lock guards.
      const stale = buildNote({ rowVersion: 1 });
      repo.put(stale);
      // Concurrent writer landed first → store now at row_version=2.
      repo.put(buildNote({ id: stale.id, rowVersion: 2 }));
      jest.spyOn(repo, 'findById').mockResolvedValueOnce(stale);
      await expect(
        service.update(KG, stale.id, MENTOR_A, USER_A, { body: 'late' }),
      ).rejects.toBeInstanceOf(OptimisticLockError);
    });

    it('stamps lastModifiedByUserId + lastModifiedAt on every PATCH', async () => {
      // B22a T7 / B18 Concern 1 — admin-bypass-on-PATCH audit trail.
      // The service must populate the audit columns from the supplied
      // `callerUserId` + `clock.now()`, regardless of which patch
      // fields were touched.
      const note = buildNote();
      repo.put(note);
      const updated = await service.update(KG, note.id, MENTOR_A, USER_A, {
        body: 'Audited',
      });
      expect(updated.lastModifiedByUserId).toBe(USER_A);
      expect(updated.lastModifiedAt).toEqual(NOW);
      expect(repo.rows.get(note.id)?.lastModifiedByUserId).toBe(USER_A);
    });

    it('stamps audit columns on the admin-override PATCH path', async () => {
      // Admin overrides happen at the controller layer by passing the
      // note's actual `mentor_id` as `callerMentorId` so the author
      // check passes. The audit stamp uses the admin's own `users.id`.
      const note = buildNote();
      repo.put(note);
      const updated = await service.update(
        KG,
        note.id,
        note.mentorId,
        ADMIN_USER,
        { body: 'Admin override' },
      );
      expect(updated.lastModifiedByUserId).toBe(ADMIN_USER);
      expect(updated.mentorId).toBe(MENTOR_A); // unchanged author
    });
  });

  describe('delete', () => {
    it('lets the author delete', async () => {
      const note = buildNote();
      repo.put(note);
      await service.delete(KG, note.id, MENTOR_A, false);
      expect(repo.rows.has(note.id)).toBe(false);
    });

    it('lets an admin delete a note authored by another mentor', async () => {
      const note = buildNote();
      repo.put(note);
      await service.delete(KG, note.id, ADMIN, true);
      expect(repo.rows.has(note.id)).toBe(false);
    });

    it('throws 403 when non-admin non-author tries to delete', async () => {
      const note = buildNote();
      repo.put(note);
      await expect(
        service.delete(KG, note.id, MENTOR_B, false),
      ).rejects.toBeInstanceOf(ProgressNoteNotAuthoredByYouError);
      expect(repo.rows.has(note.id)).toBe(true);
    });

    it('throws 404 when note not found', async () => {
      await expect(
        service.delete(KG, randomUUID(), MENTOR_A, false),
      ).rejects.toBeInstanceOf(ProgressNoteNotFoundError);
    });
  });

  describe('list', () => {
    it('listByChild filters by childId', async () => {
      const n = buildNote();
      repo.put(n);
      const result = await service.listByChild(KG, CHILD, { limit: 10 });
      expect(result.items).toHaveLength(1);
    });

    it('listByKgFiltered with mentorId returns only matching notes', async () => {
      const n1 = buildNote({ mentorId: MENTOR_A });
      const n2 = buildNote({ mentorId: MENTOR_B });
      repo.put(n1);
      repo.put(n2);
      const result = await service.listByKgFiltered(KG, {
        mentorId: MENTOR_B,
        limit: 10,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(n2.id);
    });
  });
});
