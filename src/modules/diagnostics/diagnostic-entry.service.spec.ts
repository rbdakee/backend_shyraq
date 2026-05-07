import { randomUUID } from 'node:crypto';
import { InMemoryNotificationAdapter } from '@/common/notifications/in-memory-notification.adapter';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { DiagnosticEntryService } from './diagnostic-entry.service';
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
  findByIdForUpdate(
    kgId: string,
    id: string,
  ): Promise<DiagnosticTemplate | null> {
    return this.findById(kgId, id);
  }
  update(t: DiagnosticTemplate): Promise<DiagnosticTemplate> {
    this.rows.set(t.id, t);
    return Promise.resolve(t);
  }
  list(
    _kgId: string,
    _filters: ListDiagnosticTemplatesFilter,
  ): Promise<DiagnosticTemplateListResult> {
    return Promise.resolve({ items: [], nextCursor: null });
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
  update(e: DiagnosticEntry): Promise<DiagnosticEntry> {
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
    isActive: overrides.isActive ?? true,
    schema: overrides.schema ?? validSchema,
    createdBy: STAFF_A,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function buildEntry(template: DiagnosticTemplate): DiagnosticEntry {
  return DiagnosticEntry.fromState(
    {
      id: randomUUID(),
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
    },
    NOW,
  );
}

describe('DiagnosticEntryService', () => {
  let templates: FakeTemplateRepo;
  let entries: FakeEntryRepo;
  let notification: InMemoryNotificationAdapter;
  let clock: FakeClock;
  let service: DiagnosticEntryService;

  beforeEach(() => {
    templates = new FakeTemplateRepo();
    entries = new FakeEntryRepo();
    notification = new InMemoryNotificationAdapter();
    clock = new FakeClock();
    service = new DiagnosticEntryService(
      templates,
      entries,
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
      const updated = await service.update(KG, entry.id, STAFF_A, {
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
      const updated = await service.update(KG, entry.id, STAFF_A, {
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
        service.update(KG, entry.id, STAFF_A, {
          data: { mood: 'not-a-number' as unknown as number },
        }),
      ).rejects.toMatchObject({ code: 'diagnostic_entry_data_invalid' });
    });

    it('throws 404 when entry not found', async () => {
      await expect(
        service.update(KG, randomUUID(), STAFF_A, { summary: 'x' }),
      ).rejects.toBeInstanceOf(DiagnosticEntryNotFoundError);
    });

    it('throws 403 when caller is not the author', async () => {
      const tmpl = buildTemplate();
      templates.put(tmpl);
      const entry = buildEntry(tmpl);
      entries.put(entry);
      await expect(
        service.update(KG, entry.id, STAFF_B, { summary: 'x' }),
      ).rejects.toBeInstanceOf(DiagnosticEntryNotAuthoredByYouError);
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
});
