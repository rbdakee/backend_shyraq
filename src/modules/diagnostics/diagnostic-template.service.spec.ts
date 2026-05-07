import { randomUUID } from 'node:crypto';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { DiagnosticTemplateService } from './diagnostic-template.service';
import {
  DiagnosticTemplateListResult,
  DiagnosticTemplateRepository,
  ListDiagnosticTemplatesFilter,
} from './diagnostic-template.repository';
import { DiagnosticTemplate } from './domain/entities/diagnostic-template.entity';
import { DiagnosticTemplateNotFoundError } from './domain/errors/diagnostic-template-not-found.error';
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

  findByIdForUpdate(
    kgId: string,
    id: string,
  ): Promise<DiagnosticTemplate | null> {
    return this.findById(kgId, id);
  }

  update(
    t: DiagnosticTemplate,
    _expectedVersion?: number,
  ): Promise<DiagnosticTemplate> {
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
  }> = {},
): DiagnosticTemplate {
  return DiagnosticTemplate.fromState({
    id: overrides.id ?? randomUUID(),
    kindergartenId: KG,
    specialistType: 'psychologist',
    name: 'Initial assessment',
    description: null,
    version: overrides.version ?? 1,
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
