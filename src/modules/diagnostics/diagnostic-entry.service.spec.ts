import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ChildService } from '@/modules/child/child.service';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { SpecialistType } from '@/modules/staff/domain/value-objects/specialist-type.vo';
import { StaffMemberRepository } from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { StaffService } from '@/modules/staff/staff.service';
import { OptimisticLockError } from '@/shared-kernel/domain/errors';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { DiagnosticEntryService } from './diagnostic-entry.service';
import { DiagnosticEntryPresenter } from './diagnostic-entry.presenter';
import {
  DiagnosticEntryListResult,
  DiagnosticEntryRepository,
  LatestDiagnosticEntryRow,
  ListDiagnosticEntriesFilter,
} from './diagnostic-entry.repository';
import {
  DiagnosticTemplateListResult,
  DiagnosticTemplateRepository,
  ListDiagnosticTemplatesFilter,
} from './diagnostic-template.repository';
import { DiagnosticEntry } from './domain/entities/diagnostic-entry.entity';
import { DiagnosticTemplate } from './domain/entities/diagnostic-template.entity';
import { DiagnosticEntryNotAuthoredByYouError } from './domain/errors/diagnostic-entry-not-authored-by-you.error';
import { DiagnosticEntryNotFoundError } from './domain/errors/diagnostic-entry-not-found.error';
import { DiagnosticTemplateInactiveError } from './domain/errors/diagnostic-template-inactive.error';
import { DiagnosticTemplateNotFoundError } from './domain/errors/diagnostic-template-not-found.error';
import { TemplateSchema } from './domain/schema-validators';

const KG = '11111111-1111-1111-1111-111111111111';
const STAFF_A = '22222222-2222-2222-2222-222222222222';
const STAFF_B = '33333333-3333-3333-3333-333333333333';
const CHILD = '44444444-4444-4444-4444-444444444444';
// B22a T7 — caller's `users.id` (separate from `staff_members.id`).
// Used to assert the audit-stamp wiring without coupling tests to staff.
const USER_A = '99999999-9999-9999-9999-999999999991';
const USER_B = '99999999-9999-9999-9999-999999999992';
const NOW = new Date('2026-05-01T09:00:00.000Z');
const TODAY = new Date('2026-05-01T00:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private d: Date = NOW) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakeTemplateRepo extends DiagnosticTemplateRepository {
  rows = new Map<string, DiagnosticTemplate>();

  put(t: DiagnosticTemplate): void {
    this.rows.set(t.id, t);
  }
  create(t: DiagnosticTemplate): Promise<DiagnosticTemplate> {
    this.rows.set(t.id, t);
    return Promise.resolve(t);
  }
  findById(kgId: string, id: string): Promise<DiagnosticTemplate | null> {
    const t = this.rows.get(id);
    if (!t || t.kindergartenId !== kgId) return Promise.resolve(null);
    return Promise.resolve(t);
  }
  listByIds(
    kgId: string,
    ids: string[],
  ): Promise<Map<string, DiagnosticTemplate>> {
    const map = new Map<string, DiagnosticTemplate>();
    for (const id of ids) {
      const t = this.rows.get(id);
      if (t && t.kindergartenId === kgId) {
        map.set(id, t);
      }
    }
    return Promise.resolve(map);
  }
  findByIdForUpdate(
    kgId: string,
    id: string,
  ): Promise<DiagnosticTemplate | null> {
    return this.findById(kgId, id);
  }
  update(
    t: DiagnosticTemplate,
    _expectedRowVersion?: number,
  ): Promise<DiagnosticTemplate> {
    this.rows.set(t.id, t);
    return Promise.resolve(t);
  }
  list(
    _kgId: string,
    _filters: ListDiagnosticTemplatesFilter,
  ): Promise<DiagnosticTemplateListResult> {
    return Promise.resolve({ items: [], nextCursor: null });
  }
  countEntriesUsingTemplate(
    _kgId: string,
    _templateId: string,
  ): Promise<number> {
    // Not used by DiagnosticEntryService — return 0 for completeness.
    return Promise.resolve(0);
  }
}

class FakeChildRepo {
  rows = new Map<string, { id: string; kgId: string }>();

  putActive(kgId: string, id: string): void {
    this.rows.set(`${kgId}:${id}`, { id, kgId });
  }

  // Only the methods MyTodosService / DiagnosticEntryService / ProgressNoteService
  // depend on are stubbed; the rest fall through `unknown as ChildRepository`.
  findById(kgId: string, id: string): Promise<unknown> {
    const row = this.rows.get(`${kgId}:${id}`);
    return Promise.resolve(row ? { id: row.id } : null);
  }
}

/**
 * Thin in-memory stand-in for ChildService.resolveChildNames — the real
 * children.id → full_name batch (incl. archived) is exercised in
 * child.service.spec; here we only assert DiagnosticEntryService's
 * batching/fail-closed orchestration + the presenter wiring. Backed by a
 * small id → full_name fixture.
 */
class FakeChildService {
  names = new Map<string, string>();
  put(id: string, fullName: string): void {
    this.names.set(id, fullName);
  }
  resolveChildNames(
    _kgId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of [...new Set(ids)]) {
      const name = this.names.get(id);
      if (name !== undefined) out.set(id, name);
    }
    return Promise.resolve(out);
  }
}

class FakeEntryRepo extends DiagnosticEntryRepository {
  rows = new Map<string, DiagnosticEntry>();
  createdInOrder: DiagnosticEntry[] = [];
  updatedInOrder: DiagnosticEntry[] = [];

  put(e: DiagnosticEntry): void {
    this.rows.set(e.id, e);
  }
  create(e: DiagnosticEntry): Promise<DiagnosticEntry> {
    this.rows.set(e.id, e);
    this.createdInOrder.push(e);
    return Promise.resolve(e);
  }
  findById(kgId: string, id: string): Promise<DiagnosticEntry | null> {
    const e = this.rows.get(id);
    if (!e || e.kindergartenId !== kgId) return Promise.resolve(null);
    return Promise.resolve(e);
  }
  /**
   * In-memory mirror of the relational repo's optimistic-lock contract:
   * see `diagnostic-template.service.spec.ts` for the shared rationale.
   */
  update(
    e: DiagnosticEntry,
    expectedRowVersion?: number,
  ): Promise<DiagnosticEntry> {
    if (expectedRowVersion !== undefined) {
      const current = this.rows.get(e.id);
      if (!current || current.kindergartenId !== e.kindergartenId) {
        throw new OptimisticLockError();
      }
      if (current.rowVersion !== expectedRowVersion) {
        throw new OptimisticLockError();
      }
      const bumped = DiagnosticEntry.rehydrate({
        ...e.toState(),
        rowVersion: current.rowVersion + 1,
      });
      this.rows.set(e.id, bumped);
      this.updatedInOrder.push(bumped);
      return Promise.resolve(bumped);
    }
    this.rows.set(e.id, e);
    this.updatedInOrder.push(e);
    return Promise.resolve(e);
  }
  list(
    kgId: string,
    filters: ListDiagnosticEntriesFilter,
  ): Promise<DiagnosticEntryListResult> {
    const items = Array.from(this.rows.values()).filter((e) => {
      if (e.kindergartenId !== kgId) return false;
      if (filters.childId !== undefined && e.childId !== filters.childId)
        return false;
      if (
        filters.specialistId !== undefined &&
        e.specialistId !== filters.specialistId
      )
        return false;
      if (
        filters.templateId !== undefined &&
        e.templateId !== filters.templateId
      )
        return false;
      return true;
    });
    return Promise.resolve({ items, nextCursor: null });
  }
  findLatestPerActiveChildBySpecialistType(): Promise<
    Map<string, LatestDiagnosticEntryRow>
  > {
    return Promise.resolve(new Map());
  }
}

const validSchema: TemplateSchema = {
  sections: [
    {
      title: 'General',
      fields: [
        {
          key: 'mood',
          label: 'Mood',
          type: 'scale',
          required: true,
          min: 1,
          max: 5,
        },
        {
          key: 'notes',
          label: 'Notes',
          type: 'text',
          required: false,
        },
      ],
    },
  ],
};

function buildTemplate(
  overrides: Partial<{
    id: string;
    isActive: boolean;
    schema: TemplateSchema;
  }> = {},
): DiagnosticTemplate {
  return DiagnosticTemplate.fromState({
    id: overrides.id ?? randomUUID(),
    kindergartenId: KG,
    specialistType: 'psychologist',
    name: 'Initial assessment',
    description: null,
    version: 1,
    rowVersion: 1,
    isActive: overrides.isActive ?? true,
    schema: overrides.schema ?? validSchema,
    createdBy: STAFF_A,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function buildEntry(
  template: DiagnosticTemplate,
  overrides: Partial<{ id: string; rowVersion: number }> = {},
): DiagnosticEntry {
  return DiagnosticEntry.fromState(
    {
      id: overrides.id ?? randomUUID(),
      kindergartenId: KG,
      childId: CHILD,
      templateId: template.id,
      specialistId: STAFF_A,
      assessmentDate: TODAY,
      data: { mood: 4 },
      summary: null,
      recommendations: null,
      attachments: [],
      createdAt: NOW,
      updatedAt: NOW,
      rowVersion: overrides.rowVersion ?? 1,
    },
    NOW,
  );
}

describe('DiagnosticEntryService', () => {
  let templates: FakeTemplateRepo;
  let entries: FakeEntryRepo;
  let children: FakeChildRepo;
  let notification: InMemoryNotificationAdapter;
  let clock: FakeClock;
  let service: DiagnosticEntryService;

  beforeEach(() => {
    templates = new FakeTemplateRepo();
    entries = new FakeEntryRepo();
    children = new FakeChildRepo();
    children.putActive(KG, CHILD);
    notification = new InMemoryNotificationAdapter();
    clock = new FakeClock();
    service = new DiagnosticEntryService(
      templates,
      entries,
      children as unknown as ChildRepository,
      notification,
      clock,
    );
  });

  describe('create', () => {
    it('inserts and returns the entry', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const e = await service.create(KG, {
        childId: CHILD,
        templateId: tmpl.id,
        specialistId: STAFF_A,
        assessmentDate: TODAY,
        data: { mood: 3, notes: 'ok' },
      });
      expect(e.kindergartenId).toBe(KG);
      expect(e.templateId).toBe(tmpl.id);
      expect(entries.createdInOrder).toHaveLength(1);
    });

    it('emits diagnostic_new with the template name + assessment_date', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const e = await service.create(KG, {
        childId: CHILD,
        templateId: tmpl.id,
        specialistId: STAFF_A,
        assessmentDate: TODAY,
        data: { mood: 3 },
      });
      expect(notification.events).toHaveLength(1);
      const evt = notification.events[0];
      expect(evt.type).toBe('diagnostic_new');
      expect(evt.event).toMatchObject({
        kindergartenId: KG,
        childId: CHILD,
        entryId: e.id,
        templateId: tmpl.id,
        templateName: tmpl.name,
        specialistId: STAFF_A,
        specialistType: 'psychologist',
        assessmentDate: '2026-05-01',
      });
    });

    it('throws 404 when child does not belong to the kg (cross-tenant guard)', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const foreignChildId = randomUUID();
      await expect(
        service.create(KG, {
          childId: foreignChildId,
          templateId: tmpl.id,
          specialistId: STAFF_A,
          assessmentDate: TODAY,
          data: { mood: 3 },
        }),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
      expect(entries.createdInOrder).toHaveLength(0);
      expect(notification.events).toHaveLength(0);
    });

    it('throws 404 when template does not exist', async () => {
      await expect(
        service.create(KG, {
          childId: CHILD,
          templateId: randomUUID(),
          specialistId: STAFF_A,
          assessmentDate: TODAY,
          data: { mood: 3 },
        }),
      ).rejects.toBeInstanceOf(DiagnosticTemplateNotFoundError);
      expect(notification.events).toHaveLength(0);
    });

    it('throws 409 when template is inactive', async () => {
      const tmpl = buildTemplate({ isActive: false });
      templates.put(tmpl);
      await expect(
        service.create(KG, {
          childId: CHILD,
          templateId: tmpl.id,
          specialistId: STAFF_A,
          assessmentDate: TODAY,
          data: { mood: 3 },
        }),
      ).rejects.toBeInstanceOf(DiagnosticTemplateInactiveError);
    });

    it('throws data-invalid when required field missing', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      await expect(
        service.create(KG, {
          childId: CHILD,
          templateId: tmpl.id,
          specialistId: STAFF_A,
          assessmentDate: TODAY,
          data: {},
        }),
      ).rejects.toMatchObject({
        code: 'diagnostic_entry_data_invalid',
        details: expect.objectContaining({ path: 'mood' }),
      });
      expect(notification.events).toHaveLength(0);
    });

    it('throws data-invalid when scale exceeds max', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      await expect(
        service.create(KG, {
          childId: CHILD,
          templateId: tmpl.id,
          specialistId: STAFF_A,
          assessmentDate: TODAY,
          data: { mood: 99 },
        }),
      ).rejects.toMatchObject({
        code: 'diagnostic_entry_data_invalid',
      });
    });

    it('rejects assessment_date in the future', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const future = new Date('2030-01-01T00:00:00.000Z');
      await expect(
        service.create(KG, {
          childId: CHILD,
          templateId: tmpl.id,
          specialistId: STAFF_A,
          assessmentDate: future,
          data: { mood: 3 },
        }),
      ).rejects.toMatchObject({ code: 'assessment_date_in_future' });
    });
  });

  describe('update', () => {
    it('PATCHes summary by author without re-validating data', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const entry = buildEntry(tmpl);
      entries.put(entry);
      const updated = await service.update(KG, entry.id, STAFF_A, USER_A, {
        summary: 'Calm',
      });
      expect(updated.summary).toBe('Calm');
      expect(notification.events).toHaveLength(0);
    });

    it('PATCHes data and re-validates against the bound template', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const entry = buildEntry(tmpl);
      entries.put(entry);
      const updated = await service.update(KG, entry.id, STAFF_A, USER_A, {
        data: { mood: 5, notes: 'better' },
      });
      expect((updated.data as { mood: number }).mood).toBe(5);
    });

    it('throws data-invalid when patch.data violates schema', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const entry = buildEntry(tmpl);
      entries.put(entry);
      await expect(
        service.update(KG, entry.id, STAFF_A, USER_A, {
          data: { mood: 'not-a-number' as unknown as number },
        }),
      ).rejects.toMatchObject({ code: 'diagnostic_entry_data_invalid' });
    });

    it('throws 404 when entry not found', async () => {
      await expect(
        service.update(KG, randomUUID(), STAFF_A, USER_A, { summary: 'x' }),
      ).rejects.toBeInstanceOf(DiagnosticEntryNotFoundError);
    });

    it('throws 403 when caller is not the author', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const entry = buildEntry(tmpl);
      entries.put(entry);
      await expect(
        service.update(KG, entry.id, STAFF_B, USER_B, { summary: 'x' }),
      ).rejects.toBeInstanceOf(DiagnosticEntryNotAuthoredByYouError);
    });

    it('logs orphaned_diagnostic_entry when entry.template_id resolves to nothing (B22b T5 L2)', async () => {
      // B18 L2 — operator audit channel. The data-validation branch
      // re-loads the template by id; if it has been deleted (FK + RLS
      // should prevent this, but the branch exists), surface a
      // grep-able `orphaned_diagnostic_entry` line BEFORE rethrowing
      // the generic 404. Asserts log payload contains both the entry
      // id and the dangling template id so the operator can trace
      // the breach.
      const tmpl = buildTemplate();
      // Entry exists referencing tmpl, but tmpl is NOT in the repo —
      // simulating a dangling foreign key.
      const entry = buildEntry(tmpl);
      entries.put(entry);
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      try {
        await expect(
          service.update(KG, entry.id, STAFF_A, USER_A, {
            data: { mood: 4 },
          }),
        ).rejects.toBeInstanceOf(DiagnosticTemplateNotFoundError);
        expect(errorSpy).toHaveBeenCalledTimes(1);
        const msg = errorSpy.mock.calls[0][0] as string;
        expect(msg).toContain('orphaned_diagnostic_entry');
        expect(msg).toContain(entry.id);
        expect(msg).toContain(tmpl.id);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('throws OptimisticLockError when repo signals stale row_version', async () => {
      // Race-protection regression (B22a T4 / B18 T6-M4): the service
      // must surface the repo's `OptimisticLockError` so DomainErrorFilter
      // maps it to 409 `optimistic_lock_conflict`. We simulate the
      // race by patching `findById` to return a stale snapshot while
      // the underlying store has already advanced — exactly the
      // SELECT-then-UPDATE window the optimistic lock guards.
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const stale = buildEntry(tmpl, { rowVersion: 1 });
      entries.put(stale);
      // Concurrent writer landed first → store now at row_version=2.
      entries.put(buildEntry(tmpl, { id: stale.id, rowVersion: 2 }));
      jest.spyOn(entries, 'findById').mockResolvedValueOnce(stale);
      await expect(
        service.update(KG, stale.id, STAFF_A, USER_A, { summary: 'late' }),
      ).rejects.toBeInstanceOf(OptimisticLockError);
    });

    it('stamps lastModifiedByUserId + lastModifiedAt on every PATCH', async () => {
      // B22a T7 / B18 Concern 1 — admin-bypass-on-PATCH audit trail.
      // The service must populate the audit columns from the supplied
      // `callerUserId` + `clock.now()`, regardless of which patch
      // fields were touched. Asserts both the value reaching the entity
      // and the persisted aggregate (FakeEntryRepo round-trips it).
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const entry = buildEntry(tmpl);
      entries.put(entry);
      const updated = await service.update(KG, entry.id, STAFF_A, USER_A, {
        summary: 'Audited',
      });
      expect(updated.lastModifiedByUserId).toBe(USER_A);
      expect(updated.lastModifiedAt).toEqual(NOW);
      expect(entries.rows.get(entry.id)?.lastModifiedByUserId).toBe(USER_A);
    });

    it('stamps audit columns on the admin-override PATCH path', async () => {
      // Admin overrides happen at the controller layer by passing the
      // entry's actual `specialist_id` as `callerStaffMemberId` so the
      // author check passes. The audit stamp uses the admin's own
      // `users.id` (the controller passes `user.sub`) — so the DB row
      // shows the admin's id even though the author check was a no-op.
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const entry = buildEntry(tmpl);
      entries.put(entry);
      // Simulate the controller's admin-override branch: callerStaffMemberId
      // = the entry's authoring specialist (so assertAuthoredBy passes),
      // callerUserId = the admin's own users.id (USER_B here).
      const updated = await service.update(
        KG,
        entry.id,
        entry.specialistId,
        USER_B,
        { summary: 'Admin override' },
      );
      expect(updated.lastModifiedByUserId).toBe(USER_B);
      expect(updated.specialistId).toBe(STAFF_A); // unchanged author
    });
  });

  describe('getById', () => {
    it('returns entry when present', async () => {
      const tmpl = buildTemplate();
      const entry = buildEntry(tmpl);
      entries.put(entry);
      const e = await service.getById(KG, entry.id);
      expect(e.id).toBe(entry.id);
    });

    it('throws 404 when missing', async () => {
      await expect(service.getById(KG, randomUUID())).rejects.toBeInstanceOf(
        DiagnosticEntryNotFoundError,
      );
    });
  });

  describe('getByIdForChild (parent IDOR guard)', () => {
    // B22a T8 / FINDINGS M1 — the parent controller previously called
    // `getById(kgId, entryId)` and trusted the URL `:childId` for
    // authorization without checking it matched the loaded entry's
    // child. A guardian of child A could request
    // `/parent/children/{A}/diagnostics/{entryOfB}` and receive
    // child B's data. `getByIdForChild` re-binds the lookup to the
    // URL child so the permission check becomes the actual
    // authorization boundary.
    const CHILD_OTHER = '55555555-5555-5555-5555-555555555555';

    it('returns the entry when entry.childId matches', async () => {
      const tmpl = buildTemplate();
      const entry = buildEntry(tmpl);
      entries.put(entry);
      const e = await service.getByIdForChild(KG, CHILD, entry.id);
      expect(e.id).toBe(entry.id);
    });

    it('throws 404 when entry exists but belongs to a different child (IDOR)', async () => {
      // Parent A authorized for CHILD requests entry that actually
      // belongs to CHILD_OTHER. Pre-fix this returned the foreign
      // entry; post-fix it surfaces as `diagnostic_entry_not_found`
      // (same shape as a missing row — no info-leak about whether
      // a foreign sibling has an entry under that id).
      const tmpl = buildTemplate();
      const otherChildEntry = DiagnosticEntry.fromState(
        {
          ...buildEntry(tmpl).toState(),
          id: randomUUID(),
          childId: CHILD_OTHER,
        },
        NOW,
      );
      entries.put(otherChildEntry);
      await expect(
        service.getByIdForChild(KG, CHILD, otherChildEntry.id),
      ).rejects.toBeInstanceOf(DiagnosticEntryNotFoundError);
    });

    it('throws 404 when entry does not exist at all', async () => {
      await expect(
        service.getByIdForChild(KG, CHILD, randomUUID()),
      ).rejects.toBeInstanceOf(DiagnosticEntryNotFoundError);
    });
  });

  describe('list', () => {
    it('listByChild filters by childId', async () => {
      const tmpl = buildTemplate();
      const e1 = buildEntry(tmpl);
      entries.put(e1);
      const result = await service.listByChild(KG, CHILD, { limit: 10 });
      expect(result.items).toHaveLength(1);
    });

    it('listByKgFiltered passes through specialistId filter', async () => {
      const tmpl = buildTemplate();
      const e1 = buildEntry(tmpl);
      entries.put(e1);
      const result = await service.listByKgFiltered(KG, {
        specialistId: STAFF_A,
        limit: 10,
      });
      expect(result.items).toHaveLength(1);
    });
  });

  describe('resolveSpecialists', () => {
    class FakeStaffMemberRepo {
      rows = new Map<string, StaffMember>();
      put(s: StaffMember): void {
        this.rows.set(`${s.kindergartenId}:${s.id}`, s);
      }
      findById(kgId: string, id: string): Promise<StaffMember | null> {
        return Promise.resolve(this.rows.get(`${kgId}:${id}`) ?? null);
      }
    }
    // Thin stand-in for StaffService.resolveIdentity — the real
    // staff/users fallback is exercised in staff.service.spec; here we only
    // assert DiagnosticEntryService's batching/fail-closed orchestration.
    class FakeStaffService {
      resolveIdentity(
        member: StaffMember,
      ): Promise<{ fullName: string | null; phone: string | null }> {
        const s = member.toState();
        return Promise.resolve({ fullName: s.fullName, phone: s.phone });
      }
    }
    function makeStaffMember(
      id: string,
      fullName: string | null,
      specialistType: SpecialistType | null = 'psychologist',
    ): StaffMember {
      return StaffMember.hydrate({
        id,
        kindergartenId: KG,
        userId: randomUUID(),
        fullName,
        phone: null,
        role: specialistType === null ? 'mentor' : 'specialist',
        specialistType,
        isActive: true,
        hiredAt: null,
        firedAt: null,
        archivedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    let staffRepo: FakeStaffMemberRepo;
    let resolvingService: DiagnosticEntryService;

    beforeEach(() => {
      staffRepo = new FakeStaffMemberRepo();
      resolvingService = new DiagnosticEntryService(
        templates,
        entries,
        children as unknown as ChildRepository,
        notification,
        clock,
        staffRepo as unknown as StaffMemberRepository,
        undefined, // childGuardians — unused by this overlay
        new FakeStaffService() as unknown as StaffService,
      );
    });

    it('resolves specialist_full_name + specialist_type from the staff overlay (deduped)', async () => {
      staffRepo.put(
        makeStaffMember(STAFF_A, 'Айгерим Нурланкызы', 'speech_therapist'),
      );
      const tmpl = buildTemplate();
      // Two entries by the same specialist → a single lookup, one map entry.
      const entryList = [buildEntry(tmpl), buildEntry(tmpl)];
      const map = await resolvingService.resolveSpecialists(KG, entryList);
      expect(map.size).toBe(1);
      expect(map.get(STAFF_A)).toEqual({
        fullName: 'Айгерим Нурланкызы',
        specialistType: 'speech_therapist',
      });
    });

    it('keeps specialist_type even when the staff row has a null name', async () => {
      staffRepo.put(makeStaffMember(STAFF_A, null, 'psychologist'));
      const tmpl = buildTemplate();
      const map = await resolvingService.resolveSpecialists(KG, [
        buildEntry(tmpl),
      ]);
      expect(map.get(STAFF_A)).toEqual({
        fullName: null,
        specialistType: 'psychologist',
      });
    });

    it('collapses a blank/whitespace-only specialist name to null', async () => {
      staffRepo.put(makeStaffMember(STAFF_A, '   ', 'music_teacher'));
      const tmpl = buildTemplate();
      const map = await resolvingService.resolveSpecialists(KG, [
        buildEntry(tmpl),
      ]);
      expect(map.get(STAFF_A)).toEqual({
        fullName: null,
        specialistType: 'music_teacher',
      });
    });

    it('yields a null specialist_type for a non-specialist staff member', async () => {
      // role=mentor → specialist_type is null on the staff row.
      staffRepo.put(makeStaffMember(STAFF_A, 'Мерей Ескендир', null));
      const tmpl = buildTemplate();
      const map = await resolvingService.resolveSpecialists(KG, [
        buildEntry(tmpl),
      ]);
      expect(map.get(STAFF_A)).toEqual({
        fullName: 'Мерей Ескендир',
        specialistType: null,
      });
    });

    it('returns a null overlay for a specialist whose staff row is missing', async () => {
      const tmpl = buildTemplate();
      // No staff row seeded for STAFF_A → fails closed to a null overlay.
      const map = await resolvingService.resolveSpecialists(KG, [
        buildEntry(tmpl),
      ]);
      expect(map.get(STAFF_A)).toEqual({
        fullName: null,
        specialistType: null,
      });
    });

    it('fails closed with an empty map when the staff ports are not wired', async () => {
      // `service` (the top-level instance) is constructed without the staff
      // ports — overlay resolution must degrade to an empty map, never throw.
      const tmpl = buildTemplate();
      const map = await service.resolveSpecialists(KG, [buildEntry(tmpl)]);
      expect(map.size).toBe(0);
    });
  });

  describe('resolveChildNames', () => {
    let childService: FakeChildService;
    let resolvingService: DiagnosticEntryService;

    beforeEach(() => {
      childService = new FakeChildService();
      resolvingService = new DiagnosticEntryService(
        templates,
        entries,
        children as unknown as ChildRepository,
        notification,
        clock,
        undefined, // staffMembers — unused by this overlay
        undefined, // childGuardians — unused
        undefined, // staffService — unused
        childService as unknown as ChildService,
      );
    });

    it('resolves child_name from the child overlay (children.id → full_name)', async () => {
      childService.put(CHILD, 'Алихан Сериков');
      const tmpl = buildTemplate();
      // Two entries for the same child → a single map entry (deduped).
      const entryList = [buildEntry(tmpl), buildEntry(tmpl)];
      const map = await resolvingService.resolveChildNames(KG, entryList);
      expect(map.get(CHILD)).toBe('Алихан Сериков');
      // Presenter threads the resolved name onto the wire DTO.
      const dto = DiagnosticEntryPresenter.one(
        entryList[0],
        undefined,
        null,
        map.get(entryList[0].childId) ?? null,
      );
      expect(dto.child_name).toBe('Алихан Сериков');
    });

    it('renders child_name null when the child id is absent from the map', async () => {
      const tmpl = buildTemplate();
      const entry = buildEntry(tmpl);
      // No name seeded for CHILD → not in the map → presenter renders null.
      const map = await resolvingService.resolveChildNames(KG, [entry]);
      expect(map.has(CHILD)).toBe(false);
      const dto = DiagnosticEntryPresenter.one(
        entry,
        undefined,
        null,
        map.get(entry.childId) ?? null,
      );
      expect(dto.child_name).toBeNull();
    });

    it('fails closed with an empty map when the child port is not wired', async () => {
      // `service` (top-level) is constructed without the ChildService port —
      // overlay resolution must degrade to an empty map, never throw.
      const tmpl = buildTemplate();
      const map = await service.resolveChildNames(KG, [buildEntry(tmpl)]);
      expect(map.size).toBe(0);
    });
  });
});
