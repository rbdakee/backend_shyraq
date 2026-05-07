import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { MyTodosService } from './my-todos.service';
import {
  DiagnosticEntryListResult,
  DiagnosticEntryRepository,
  LatestDiagnosticEntryRow,
  ListDiagnosticEntriesFilter,
} from './diagnostic-entry.repository';
import { DiagnosticEntry } from './domain/entities/diagnostic-entry.entity';
import { StaffMemberMustHaveSpecialistTypeError } from './domain/errors/staff-member-must-have-specialist-type.error';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD_NEW = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHILD_RECENT = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHILD_STALE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
// "Today" in the spec — a known calendar date in Asia/Almaty (UTC+5)
// `2026-05-01T05:00:00Z` ≈ midday in Almaty on 2026-05-01.
const NOW = new Date('2026-05-01T05:00:00.000Z');

class FakeClock extends ClockPort {
  constructor(private d: Date = NOW) {
    super();
  }
  now(): Date {
    return this.d;
  }
}

class FakeChildRepo {
  active: Array<{ id: string; fullName: string }> = [];

  listActiveLightByKg(
    _kindergartenId: string,
  ): Promise<Array<{ id: string; fullName: string }>> {
    return Promise.resolve(this.active);
  }
}

class FakeEntryRepo extends DiagnosticEntryRepository {
  latest = new Map<string, LatestDiagnosticEntryRow>();

  create(): Promise<DiagnosticEntry> {
    throw new Error('not used');
  }
  findById(): Promise<DiagnosticEntry | null> {
    return Promise.resolve(null);
  }
  update(): Promise<DiagnosticEntry> {
    throw new Error('not used');
  }
  list(
    _kgId: string,
    _filters: ListDiagnosticEntriesFilter,
  ): Promise<DiagnosticEntryListResult> {
    return Promise.resolve({ items: [], nextCursor: null });
  }
  findLatestPerActiveChildBySpecialistType(): Promise<
    Map<string, LatestDiagnosticEntryRow>
  > {
    return Promise.resolve(this.latest);
  }
}

describe('MyTodosService', () => {
  let children: FakeChildRepo;
  let entries: FakeEntryRepo;
  let service: MyTodosService;

  beforeEach(() => {
    children = new FakeChildRepo();
    entries = new FakeEntryRepo();
    service = new MyTodosService(
      children as unknown as ChildRepository,
      entries,
      new FakeClock(NOW),
    );
  });

  it('returns todos for a non-admin caller with specialist_type', async () => {
    children.active = [{ id: CHILD_NEW, fullName: 'New Child' }];
    const result = await service.getMyTodos(
      KG,
      'psychologist',
      undefined,
      false,
    );
    expect(result.childrenNeedingDiagnostic).toHaveLength(1);
    expect(result.childrenNeedingDiagnostic[0]).toMatchObject({
      childId: CHILD_NEW,
      childFullName: 'New Child',
      lastDiagnosticDate: null,
      daysSinceLast: null,
    });
  });

  it('admin without own specialist_type passes ?specialist_type override', async () => {
    children.active = [{ id: CHILD_NEW, fullName: 'New Child' }];
    const result = await service.getMyTodos(KG, null, 'psychologist', true);
    expect(result.childrenNeedingDiagnostic).toHaveLength(1);
  });

  it('admin without override and without own specialist_type → 403', async () => {
    await expect(
      service.getMyTodos(KG, null, undefined, true),
    ).rejects.toBeInstanceOf(StaffMemberMustHaveSpecialistTypeError);
  });

  it('non-admin caller without specialist_type → 403', async () => {
    await expect(
      service.getMyTodos(KG, null, undefined, false),
    ).rejects.toBeInstanceOf(StaffMemberMustHaveSpecialistTypeError);
  });

  it('child with no entries is included with last=null, days=null', async () => {
    children.active = [{ id: CHILD_NEW, fullName: 'Never Assessed' }];
    const result = await service.getMyTodos(
      KG,
      'psychologist',
      undefined,
      false,
    );
    expect(result.childrenNeedingDiagnostic[0].lastDiagnosticDate).toBeNull();
    expect(result.childrenNeedingDiagnostic[0].daysSinceLast).toBeNull();
  });

  it('child with entry < 6 months old is excluded', async () => {
    // 2 months ago (≈ 60 days)
    const recent = new Date('2026-03-01T00:00:00.000Z');
    children.active = [{ id: CHILD_RECENT, fullName: 'Recent Child' }];
    entries.latest.set(CHILD_RECENT, {
      childId: CHILD_RECENT,
      assessmentDate: recent,
    });
    const result = await service.getMyTodos(
      KG,
      'psychologist',
      undefined,
      false,
    );
    expect(result.childrenNeedingDiagnostic).toHaveLength(0);
  });

  it('child with entry > 6 months old is included with daysSinceLast filled', async () => {
    // ~7 months ago
    const stale = new Date('2025-09-15T00:00:00.000Z');
    children.active = [{ id: CHILD_STALE, fullName: 'Stale Child' }];
    entries.latest.set(CHILD_STALE, {
      childId: CHILD_STALE,
      assessmentDate: stale,
    });
    const result = await service.getMyTodos(
      KG,
      'psychologist',
      undefined,
      false,
    );
    expect(result.childrenNeedingDiagnostic).toHaveLength(1);
    expect(result.childrenNeedingDiagnostic[0].lastDiagnosticDate).toBe(
      '2025-09-15',
    );
    expect(result.childrenNeedingDiagnostic[0].daysSinceLast).toBeGreaterThan(
      180,
    );
  });

  it('sorts never-assessed first, then most-stale by descending days', async () => {
    const stale = new Date('2025-09-15T00:00:00.000Z');
    const veryStale = new Date('2024-09-15T00:00:00.000Z');
    children.active = [
      { id: CHILD_STALE, fullName: 'Stale' },
      { id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', fullName: 'Very Stale' },
      { id: CHILD_NEW, fullName: 'Never' },
    ];
    entries.latest.set(CHILD_STALE, {
      childId: CHILD_STALE,
      assessmentDate: stale,
    });
    entries.latest.set('dddddddd-dddd-dddd-dddd-dddddddddddd', {
      childId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
      assessmentDate: veryStale,
    });

    const result = await service.getMyTodos(
      KG,
      'psychologist',
      undefined,
      false,
    );
    expect(result.childrenNeedingDiagnostic).toHaveLength(3);
    // Never-assessed first (daysSinceLast === null)
    expect(result.childrenNeedingDiagnostic[0].childId).toBe(CHILD_NEW);
    // Then very stale, then less stale
    expect(result.childrenNeedingDiagnostic[1].childId).toBe(
      'dddddddd-dddd-dddd-dddd-dddddddddddd',
    );
    expect(result.childrenNeedingDiagnostic[2].childId).toBe(CHILD_STALE);
  });

  it('archived children are excluded — relies on listActiveLightByKg', async () => {
    // The method is contract: only active children come back. Verify that
    // when no active children are returned, the response is empty.
    children.active = [];
    const result = await service.getMyTodos(
      KG,
      'psychologist',
      undefined,
      false,
    );
    expect(result.childrenNeedingDiagnostic).toHaveLength(0);
  });

  it('admin override beats own specialist_type', async () => {
    // Admin has 'psychologist' but passes 'speech_therapist'.
    children.active = [{ id: CHILD_NEW, fullName: 'X' }];
    // The repo returns no entries for either specialist_type — both yield
    // never-assessed. We just verify the call goes through without throwing.
    const result = await service.getMyTodos(
      KG,
      'psychologist',
      'speech_therapist',
      true,
    );
    expect(result.childrenNeedingDiagnostic).toHaveLength(1);
  });
});
