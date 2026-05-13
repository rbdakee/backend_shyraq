import { randomUUID } from 'node:crypto';
import { OptimisticLockError } from '@/shared-kernel/domain/errors';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { DiagnosticTemplateService } from './diagnostic-template.service';
import {
  DiagnosticTemplateListResult,
  DiagnosticTemplateRepository,
  ListDiagnosticTemplatesFilter,
} from './diagnostic-template.repository';
import { DiagnosticTemplate } from './domain/entities/diagnostic-template.entity';
import { DiagnosticTemplateNotFoundError } from './domain/errors/diagnostic-template-not-found.error';
import { TemplateHasEntriesError } from './domain/errors/template-has-entries.error';
import { TemplateSchema } from './domain/schema-validators';

const KG = '11111111-1111-1111-1111-111111111111';
const STAFF = '22222222-2222-2222-2222-222222222222';
const NOW = new Date('2026-05-01T09:00:00.000Z');
const LATER = new Date('2026-05-02T09:00:00.000Z');

class FakeClock extends ClockPort {
  private d: Date;
  constructor(d: Date = NOW) {
    super();
    this.d = d;
  }
  now(): Date {
    return this.d;
  }
  set(d: Date): void {
    this.d = d;
  }
}

class FakeTemplateRepo extends DiagnosticTemplateRepository {
  rows = new Map<string, DiagnosticTemplate>();
  /** B22a T7 — per-template entry-count surface used by H12 schema-PATCH guard. */
  entriesCount = new Map<string, number>();

  put(t: DiagnosticTemplate): void {
    this.rows.set(t.id, t);
  }

  setEntriesCount(templateId: string, count: number): void {
    this.entriesCount.set(templateId, count);
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

  findByIdForUpdate(
    kgId: string,
    id: string,
  ): Promise<DiagnosticTemplate | null> {
    return this.findById(kgId, id);
  }

  countEntriesUsingTemplate(
    _kgId: string,
    templateId: string,
  ): Promise<number> {
    return Promise.resolve(this.entriesCount.get(templateId) ?? 0);
  }

  /**
   * In-memory mirror of the relational repo's optimistic-lock contract:
   * when `expectedRowVersion` is supplied, the snapshot's current
   * row_version must match — otherwise throw `OptimisticLockError`.
   * Mirrors the row_version bump deterministically so unit specs can
   * pin behaviour without spinning up Postgres.
   */
  update(
    t: DiagnosticTemplate,
    expectedRowVersion?: number,
  ): Promise<DiagnosticTemplate> {
    if (expectedRowVersion !== undefined) {
      const current = this.rows.get(t.id);
      if (!current || current.kindergartenId !== t.kindergartenId) {
        throw new OptimisticLockError();
      }
      if (current.rowVersion !== expectedRowVersion) {
        throw new OptimisticLockError();
      }
      const bumped = DiagnosticTemplate.fromState({
        ...t.toState(),
        rowVersion: current.rowVersion + 1,
      });
      this.rows.set(t.id, bumped);
      return Promise.resolve(bumped);
    }
    this.rows.set(t.id, t);
    return Promise.resolve(t);
  }

  list(
    kgId: string,
    filters: ListDiagnosticTemplatesFilter,
  ): Promise<DiagnosticTemplateListResult> {
    const items = Array.from(this.rows.values()).filter((t) => {
      if (t.kindergartenId !== kgId) return false;
      if (
        filters.specialistType !== undefined &&
        t.specialistType !== filters.specialistType
      )
        return false;
      if (filters.isActive !== undefined && t.isActive !== filters.isActive)
        return false;
      return true;
    });
    return Promise.resolve({ items, nextCursor: null });
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
    version: number;
    rowVersion: number;
  }> = {},
): DiagnosticTemplate {
  return DiagnosticTemplate.fromState({
    id: overrides.id ?? randomUUID(),
    kindergartenId: KG,
    specialistType: 'psychologist',
    name: 'Initial assessment',
    description: null,
    version: overrides.version ?? 1,
    rowVersion: overrides.rowVersion ?? 1,
    isActive: overrides.isActive ?? true,
    schema: overrides.schema ?? validSchema,
    createdBy: STAFF,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe('DiagnosticTemplateService', () => {
  let repo: FakeTemplateRepo;
  let clock: FakeClock;
  let service: DiagnosticTemplateService;

  beforeEach(() => {
    repo = new FakeTemplateRepo();
    clock = new FakeClock(NOW);
    service = new DiagnosticTemplateService(repo, clock);
  });

  describe('create', () => {
    it('inserts a new template with version=1 and isActive=true', async () => {
      const t = await service.create(
        KG,
        {
          specialistType: 'psychologist',
          name: 'New template',
          schema: validSchema,
        },
        STAFF,
      );
      expect(t.version).toBe(1);
      expect(t.isActive).toBe(true);
      expect(t.kindergartenId).toBe(KG);
      expect(t.createdBy).toBe(STAFF);
      expect(repo.rows.has(t.id)).toBe(true);
    });

    it('throws schema-invalid when sections is empty', async () => {
      await expect(
        service.create(
          KG,
          {
            specialistType: 'psychologist',
            name: 'X',
            schema: { sections: [] } as unknown as TemplateSchema,
          },
          STAFF,
        ),
      ).rejects.toMatchObject({ code: 'diagnostic_template_schema_invalid' });
    });
  });

  describe('update', () => {
    it('PATCHes name without bumping version when schema unchanged', async () => {
      const initial = buildTemplate();
      repo.put(initial);
      clock.set(LATER);
      const updated = await service.update(KG, initial.id, {
        name: 'Renamed',
      });
      expect(updated.name).toBe('Renamed');
      expect(updated.version).toBe(1);
      expect(updated.updatedAt).toEqual(LATER);
    });

    it('bumps version when schema differs', async () => {
      const initial = buildTemplate();
      repo.put(initial);
      const newSchema: TemplateSchema = {
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
                max: 10,
              },
            ],
          },
        ],
      };
      const updated = await service.update(KG, initial.id, {
        schema: newSchema,
      });
      expect(updated.version).toBe(2);
    });

    it('throws 404 when template does not exist', async () => {
      await expect(
        service.update(KG, randomUUID(), { name: 'X' }),
      ).rejects.toBeInstanceOf(DiagnosticTemplateNotFoundError);
    });

    it('rejects cross-tenant template (returns 404)', async () => {
      const initial = buildTemplate();
      repo.put(initial);
      await expect(
        service.update('other-kg', initial.id, { name: 'X' }),
      ).rejects.toBeInstanceOf(DiagnosticTemplateNotFoundError);
    });

    it('rejects schema patch with malformed shape', async () => {
      const initial = buildTemplate();
      repo.put(initial);
      await expect(
        service.update(KG, initial.id, {
          schema: { sections: 'not-an-array' } as unknown as TemplateSchema,
        }),
      ).rejects.toMatchObject({ code: 'diagnostic_template_schema_invalid' });
    });

    it('throws OptimisticLockError when repo signals stale row_version', async () => {
      // Race-protection regression (B22a T4 / SM3): the service must
      // surface the repo's `OptimisticLockError` so DomainErrorFilter
      // maps it to 409 `optimistic_lock_conflict`. We simulate the
      // race by patching `findById` to return a stale snapshot
      // (row_version=1) while the underlying store has already
      // advanced (row_version=2) — exactly the SELECT-then-UPDATE
      // window the optimistic lock guards.
      const initial = buildTemplate({ rowVersion: 1 });
      repo.put(initial);
      // Concurrent writer landed first → store now at row_version=2.
      const winner = buildTemplate({ id: initial.id, rowVersion: 2 });
      repo.put(winner);
      // The "loser" service call reads the snapshot it had BEFORE the
      // winner committed (still row_version=1). Real Postgres exposes
      // this gap via the read-then-conditional-update pattern.
      jest.spyOn(repo, 'findById').mockResolvedValueOnce(initial);
      await expect(
        service.update(KG, initial.id, { name: 'Late writer' }),
      ).rejects.toBeInstanceOf(OptimisticLockError);
    });

    it('passes expectedRowVersion to repo on subsequent update success', async () => {
      // Sanity: after a successful PATCH the repo bumps row_version, so
      // a follow-up service.update against the latest aggregate succeeds.
      const initial = buildTemplate();
      repo.put(initial);
      const first = await service.update(KG, initial.id, { name: 'A' });
      expect(first.rowVersion).toBe(2);
      const second = await service.update(KG, initial.id, { name: 'B' });
      expect(second.rowVersion).toBe(3);
    });

    it('rejects schema PATCH with 409 template_has_entries when entries exist', async () => {
      // B22a T7 / H12 — schema is pinned the moment any entry references
      // the template. Mutating the JSONB schema would silently invalidate
      // every persisted entry's `data` payload (validated against the
      // live template on read), so we throw `TemplateHasEntriesError`
      // (HTTP 409 `template_has_entries`) before any write.
      const initial = buildTemplate();
      repo.put(initial);
      repo.setEntriesCount(initial.id, 3);
      const newSchema: TemplateSchema = {
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
                max: 10,
              },
            ],
          },
        ],
      };
      await expect(
        service.update(KG, initial.id, { schema: newSchema }),
      ).rejects.toBeInstanceOf(TemplateHasEntriesError);
      // Sanity: persisted row is untouched (no row_version bump, no
      // schema change) — the guard fires BEFORE the conditional UPDATE.
      const reloaded = repo.rows.get(initial.id);
      expect(reloaded?.schema).toEqual(initial.schema);
      expect(reloaded?.rowVersion).toBe(1);
    });

    it('allows non-schema PATCH (name only) even when entries exist', async () => {
      // H12 only blocks structural schema diffs — `name`, `description`,
      // and `is_active` mutations remain editable in the entries-pinned
      // state.
      const initial = buildTemplate();
      repo.put(initial);
      repo.setEntriesCount(initial.id, 5);
      const updated = await service.update(KG, initial.id, {
        name: 'Renamed (with entries)',
      });
      expect(updated.name).toBe('Renamed (with entries)');
      expect(updated.version).toBe(1);
    });

    it('allows schema PATCH that is structurally identical (no-op) when entries exist', async () => {
      // Common UI pattern: edit `name`, re-send the whole template
      // including the unchanged `schema` block. `deepEqualJson` returns
      // true so the H12 guard short-circuits — no 409, no version bump.
      const initial = buildTemplate();
      repo.put(initial);
      repo.setEntriesCount(initial.id, 2);
      const sameSchema: TemplateSchema = JSON.parse(
        JSON.stringify(initial.schema),
      ) as TemplateSchema;
      const updated = await service.update(KG, initial.id, {
        name: 'Renamed',
        schema: sameSchema,
      });
      expect(updated.name).toBe('Renamed');
      expect(updated.version).toBe(1); // schema unchanged → no bump
    });

    it('allows schema PATCH when no entries exist', async () => {
      // Sanity: H12 guard is gated on `entriesCount > 0`. With zero
      // entries the schema mutation goes through and the version bumps
      // per existing semantics.
      const initial = buildTemplate();
      repo.put(initial);
      repo.setEntriesCount(initial.id, 0);
      const newSchema: TemplateSchema = {
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
                max: 10,
              },
            ],
          },
        ],
      };
      const updated = await service.update(KG, initial.id, {
        schema: newSchema,
      });
      expect(updated.version).toBe(2);
    });
  });

  describe('deactivate', () => {
    it('flips isActive to false and persists', async () => {
      const initial = buildTemplate();
      repo.put(initial);
      const deactivated = await service.deactivate(KG, initial.id);
      expect(deactivated.isActive).toBe(false);
      expect(repo.rows.get(initial.id)?.isActive).toBe(false);
    });

    it('throws InvariantViolationError when already inactive', async () => {
      const initial = buildTemplate({ isActive: false });
      repo.put(initial);
      await expect(service.deactivate(KG, initial.id)).rejects.toMatchObject({
        code: 'already_inactive',
      });
    });

    it('throws 404 when not found', async () => {
      await expect(service.deactivate(KG, randomUUID())).rejects.toBeInstanceOf(
        DiagnosticTemplateNotFoundError,
      );
    });
  });

  describe('getById', () => {
    it('returns the template when present', async () => {
      const initial = buildTemplate();
      repo.put(initial);
      const t = await service.getById(KG, initial.id);
      expect(t.id).toBe(initial.id);
    });

    it('throws 404 when missing', async () => {
      await expect(service.getById(KG, randomUUID())).rejects.toBeInstanceOf(
        DiagnosticTemplateNotFoundError,
      );
    });
  });

  describe('list', () => {
    it('passes filters through to the repo', async () => {
      const t1 = buildTemplate();
      const t2 = buildTemplate({ isActive: false });
      repo.put(t1);
      repo.put(t2);
      const result = await service.list(KG, { isActive: true, limit: 20 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(t1.id);
    });
  });
});
