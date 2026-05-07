/**
 * EnrollmentService — service-unit suite. All collaborators are hand-written
 * in-memory fakes (no Jest auto-mock). The card_created edge stubs
 * ChildService entirely, since the service-level contract is "ChildService
 * received the right inputs and the back-link was applied"; the real
 * ChildService.createChild + inviteGuardian wiring is exercised by the
 * service-integration spec sibling against a real database.
 */
import { InvoiceService } from '@/modules/billing/invoice.service';
import {
  Invoice,
  InvoiceState,
} from '@/modules/billing/domain/entities/invoice.entity';
import { TariffAssignmentNotFoundError } from '@/modules/billing/domain/errors/tariff-assignment-not-found.error';
import { ChildService } from '@/modules/child/child.service';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { Group } from '@/modules/group/domain/entities/group.entity';
import { GroupNotFoundError } from '@/modules/group/domain/errors/group-not-found.error';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import {
  CreateGroupInput,
  GroupRepository,
  ListGroupsFilters,
  UpdateGroupInput,
} from '@/modules/group/infrastructure/persistence/group.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import { StaffNotFoundError } from '@/modules/staff/domain/errors/staff-not-found.error';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { UserId } from '@/shared-kernel/domain/value-objects/user-id.vo';
import { Enrollment } from './domain/entities/enrollment.entity';
import { EnrollmentLockedError } from './domain/errors/enrollment-locked.error';
import { EnrollmentMissingRequiredFieldsError } from './domain/errors/enrollment-missing-required-fields.error';
import { EnrollmentNotFoundError } from './domain/errors/enrollment-not-found.error';
import { EnrollmentTransitionConflictError } from './domain/errors/enrollment-transition-conflict.error';
import { InvalidEnrollmentStatusTransitionError } from './domain/errors/invalid-enrollment-status-transition.error';
import { EnrollmentStatusValue } from './domain/value-objects/enrollment-status.vo';
import {
  EnrollmentStatusLogEntry,
  EnrollmentStatusLogEntryDraft,
} from './domain/types/enrollment-status-log-entry';
import { EnrollmentStatusLogRepository } from './infrastructure/persistence/enrollment-status-log.repository';
import {
  EnrollmentListFilter,
  EnrollmentListResult,
  EnrollmentRepository,
} from './infrastructure/persistence/enrollment.repository';
import { EnrollmentService } from './enrollment.service';

// ── fakes ────────────────────────────────────────────────────────────────

class FixedClock extends ClockPort {
  constructor(private readonly fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
}

/**
 * Round-trip clone via toState/hydrate so the fake's stored copy is
 * decoupled from whatever the service mutates after the call returns. This
 * matches the behaviour of the real relational repo: each `findById` reads a
 * fresh row.
 */
function cloneEnrollment(e: Enrollment): Enrollment {
  return Enrollment.hydrate(e.toState());
}

class FakeEnrollmentRepository extends EnrollmentRepository {
  rows = new Map<string, Enrollment>();
  /**
   * Per-id override that forces `updateWithExpectedStatus` to return false on
   * its next invocation — used by the conflict-path test to simulate a
   * concurrent transition having moved the row out from under us.
   */
  forceConflictOnce = new Set<string>();

  put(e: Enrollment): void {
    this.rows.set(e.id, cloneEnrollment(e));
  }

  create(_kg: string, e: Enrollment): Promise<Enrollment> {
    this.rows.set(e.id, cloneEnrollment(e));
    return Promise.resolve(cloneEnrollment(e));
  }

  findById(kg: string, id: string): Promise<Enrollment | null> {
    const found = this.rows.get(id);
    if (!found || found.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(cloneEnrollment(found));
  }

  update(kg: string, e: Enrollment): Promise<Enrollment> {
    const existing = this.rows.get(e.id);
    if (!existing || existing.kindergartenId !== kg) {
      throw new Error('update: row missing');
    }
    this.rows.set(e.id, cloneEnrollment(e));
    return Promise.resolve(cloneEnrollment(e));
  }

  updateWithExpectedStatus(
    kg: string,
    e: Enrollment,
    expectedOldStatus: EnrollmentStatusValue,
  ): Promise<boolean> {
    if (this.forceConflictOnce.has(e.id)) {
      this.forceConflictOnce.delete(e.id);
      return Promise.resolve(false);
    }
    const existing = this.rows.get(e.id);
    if (!existing || existing.kindergartenId !== kg) {
      return Promise.resolve(false);
    }
    if (existing.status.value !== expectedOldStatus) {
      return Promise.resolve(false);
    }
    this.rows.set(e.id, cloneEnrollment(e));
    return Promise.resolve(true);
  }

  list(kg: string, f: EnrollmentListFilter): Promise<EnrollmentListResult> {
    let items = [...this.rows.values()].filter((e) => e.kindergartenId === kg);
    if (f.status !== undefined) {
      items = items.filter((e) => e.status.value === f.status);
    }
    if (f.q !== undefined && f.q.length > 0) {
      const ql = f.q.toLowerCase();
      items = items.filter(
        (e) =>
          (e.childName !== null && e.childName.toLowerCase().includes(ql)) ||
          e.contactPhone === f.q,
      );
    }
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = items.length;
    const start = (f.page - 1) * f.limit;
    const page = items.slice(start, start + f.limit);
    return Promise.resolve({
      items: page.map((e) => cloneEnrollment(e)),
      total,
    });
  }
}

class FakeEnrollmentStatusLogRepository extends EnrollmentStatusLogRepository {
  rows: EnrollmentStatusLogEntry[] = [];
  private nextId = 1;

  append(
    kg: string,
    draft: EnrollmentStatusLogEntryDraft,
  ): Promise<EnrollmentStatusLogEntry> {
    const entry: EnrollmentStatusLogEntry = {
      id: `log-${this.nextId++}`,
      enrollmentId: draft.enrollmentId,
      kindergartenId: kg,
      fromStatus: draft.fromStatus,
      toStatus: draft.toStatus,
      changedBy: draft.changedBy,
      comment: draft.comment,
      createdAt: draft.createdAt,
    };
    this.rows.push(entry);
    return Promise.resolve({ ...entry });
  }

  listForEnrollment(
    kg: string,
    enrollmentId: string,
  ): Promise<EnrollmentStatusLogEntry[]> {
    const items = this.rows
      .filter((r) => r.kindergartenId === kg && r.enrollmentId === enrollmentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((r) => ({ ...r }));
    return Promise.resolve(items);
  }
}

class FakeStaffRepo extends StaffMemberRepository {
  byId = new Map<string, StaffMember>();

  put(s: StaffMember): void {
    this.byId.set(s.id, s);
  }

  create(_input: CreateStaffMemberInput): Promise<StaffMember> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<StaffMember | null> {
    const s = this.byId.get(id);
    if (!s || s.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(s);
  }
  findActiveByUserAndKindergarten(
    userId: string,
    kg: string,
  ): Promise<StaffMember | null> {
    const found =
      [...this.byId.values()].find(
        (s) => s.userId === userId && s.kindergartenId === kg && s.isActive,
      ) ?? null;
    return Promise.resolve(found);
  }
  listByKindergarten(
    kg: string,
    _filters?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((s) => s.kindergartenId === kg),
    );
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    throw new Error('not used');
  }
  save(s: StaffMember): Promise<StaffMember> {
    this.byId.set(s.id, s);
    return Promise.resolve(s);
  }
  deactivateAllByKindergarten(_kg: string, _now: Date): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(userId: string): Promise<StaffMember[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((s) => s.userId === userId && s.isActive),
    );
  }
}

class FakeGroupRepo extends GroupRepository {
  byId = new Map<string, Group>();

  put(g: Group): void {
    this.byId.set(g.id, g);
  }

  create(_kg: string, _input: CreateGroupInput): Promise<Group> {
    throw new Error('not used');
  }
  findById(kg: string, id: string): Promise<Group | null> {
    const g = this.byId.get(id);
    if (!g || g.kindergartenId !== kg) return Promise.resolve(null);
    return Promise.resolve(g);
  }
  list(kg: string, _filters?: ListGroupsFilters): Promise<Group[]> {
    return Promise.resolve(
      [...this.byId.values()].filter((g) => g.kindergartenId === kg),
    );
  }
  update(
    _kg: string,
    _id: string,
    _patch: UpdateGroupInput,
  ): Promise<Group | null> {
    throw new Error('not used');
  }
  save(g: Group): Promise<Group> {
    this.byId.set(g.id, g);
    return Promise.resolve(g);
  }
  assignMentor(
    _kg: string,
    _gid: string,
    _sid: string,
    _now: Date,
  ): Promise<GroupMentor> {
    throw new Error('not used');
  }
  unassignMentor(
    _kg: string,
    _gid: string,
    _now: Date,
  ): Promise<GroupMentor | null> {
    throw new Error('not used');
  }
  unassignMentorByStaffMember(
    _kg: string,
    _sid: string,
    _now: Date,
  ): Promise<number> {
    return Promise.resolve(0);
  }
  findActiveMentor(_kg: string, _gid: string): Promise<GroupMentor | null> {
    throw new Error('not used');
  }
  listMentorHistory(_kg: string, _gid: string): Promise<GroupMentor[]> {
    throw new Error('not used');
  }
  findActiveMentorAssignmentsByUserIdCrossTenant(
    _userId: string,
  ): Promise<GroupMentor[]> {
    throw new Error('not used');
  }
}

interface CreateChildCall {
  kindergartenId: string;
  fullName: string;
  iin: string | undefined;
  dateOfBirth: Date;
  currentGroupId: string | undefined;
}

interface InviteGuardianCall {
  kindergartenId: string;
  childId: string;
  userPhone: string | undefined;
  role: string;
  canPickup: boolean | undefined;
  invitedByUserId: string;
}

interface GenerateFirstInvoiceCall {
  kindergartenId: string;
  childId: string;
  enrollmentDate: Date;
  assignedBy: string;
}

/**
 * In-memory stub of `InvoiceService.generateFirstInvoice` — the only method
 * EnrollmentService consumes. Captures call args and either returns a
 * deterministic Invoice POJO or throws the configured error so the
 * card_created branch can exercise both happy + rollback paths.
 */
class StubInvoiceService {
  generateFirstInvoiceCalls: GenerateFirstInvoiceCall[] = [];
  errorToThrow: Error | null = null;

  generateFirstInvoice = (
    kindergartenId: string,
    input: {
      childId: string;
      enrollmentDate: Date;
      assignedBy: string;
    },
  ): Promise<Invoice> => {
    this.generateFirstInvoiceCalls.push({
      kindergartenId,
      childId: input.childId,
      enrollmentDate: input.enrollmentDate,
      assignedBy: input.assignedBy,
    });
    if (this.errorToThrow) return Promise.reject(this.errorToThrow);
    const state: InvoiceState = {
      id: `inv-${this.generateFirstInvoiceCalls.length}`,
      kindergartenId,
      childId: input.childId,
      paymentAccountId: `pa-${input.childId}`,
      tariffPlanId: 'tariff-1',
      invoiceType: 'monthly',
      periodStart: input.enrollmentDate,
      periodEnd: input.enrollmentDate,
      amountDue: 100000,
      discountPct: null,
      discountReason: null,
      amountAfterDiscount: 100000,
      status: 'pending',
      dueDate: input.enrollmentDate,
      description: null,
      proratedForDays: null,
      createdAt: input.enrollmentDate,
      updatedAt: input.enrollmentDate,
    };
    return Promise.resolve(Invoice.fromState(state));
  };
}

class StubChildService {
  createChildCalls: CreateChildCall[] = [];
  inviteGuardianCalls: InviteGuardianCall[] = [];
  childToReturn: Child | null = null;
  guardianToReturn: ChildGuardian | null = null;
  inviteGuardianError: Error | null = null;

  createChild = (
    kindergartenId: string,
    input: {
      fullName: string;
      iin?: string;
      dateOfBirth: Date;
      currentGroupId?: string;
    },
  ): Promise<Child> => {
    this.createChildCalls.push({
      kindergartenId,
      fullName: input.fullName,
      iin: input.iin,
      dateOfBirth: input.dateOfBirth,
      currentGroupId: input.currentGroupId,
    });
    if (this.childToReturn) return Promise.resolve(this.childToReturn);
    throw new Error('StubChildService.childToReturn not set');
  };

  inviteGuardian = (
    kindergartenId: string,
    input: {
      childId: string;
      userPhone?: string;
      role: string;
      canPickup?: boolean;
      invitedByUserId: string;
    },
  ): Promise<ChildGuardian> => {
    this.inviteGuardianCalls.push({
      kindergartenId,
      childId: input.childId,
      userPhone: input.userPhone,
      role: input.role,
      canPickup: input.canPickup,
      invitedByUserId: input.invitedByUserId,
    });
    if (this.inviteGuardianError)
      return Promise.reject(this.inviteGuardianError);
    if (this.guardianToReturn) return Promise.resolve(this.guardianToReturn);
    throw new Error('StubChildService.guardianToReturn not set');
  };
}

// ── fixtures ─────────────────────────────────────────────────────────────

const KG_A = 'a1a1a1a1-0000-0000-0000-000000000001';
const KG_B = 'b2b2b2b2-0000-0000-0000-000000000002';
const STAFF_USER_ID = 'cccccccc-0000-0000-0000-000000000003';
const STAFF_MEMBER_ID = 'dddddddd-0000-0000-0000-000000000004';
const ASSIGNED_STAFF_ID = 'eeeeeeee-0000-0000-0000-000000000005';
const GROUP_ID = 'ffffffff-0000-0000-0000-000000000006';
const CHILD_ID = '11111111-0000-0000-0000-000000000007';
const T0 = new Date('2026-04-30T10:00:00.000Z');

function aStaff(
  id: string,
  userId: string,
  kg: string,
  isActive = true,
): StaffMember {
  return StaffMember.hydrate({
    id,
    kindergartenId: kg,
    userId,
    fullName: `Staff ${id.slice(0, 4)}`,
    phone: '+77011111111',
    role: 'admin',
    specialistType: null,
    isActive,
    hiredAt: T0,
    firedAt: null,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

function aGroup(id: string, kg: string): Group {
  return Group.hydrate({
    id,
    kindergartenId: kg,
    name: `Group ${id.slice(0, 4)}`,
    capacity: 20,
    ageRangeMin: 3,
    ageRangeMax: 5,
    currentLocationId: null,
    archivedAt: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

function aChild(id: string, kg: string): Child {
  return Child.hydrate({
    id,
    kindergartenId: kg,
    iin: null,
    fullName: 'Sample Child',
    dateOfBirth: new Date('2021-08-15T00:00:00.000Z'),
    gender: null,
    photoUrl: null,
    status: 'card_created',
    currentGroupId: GROUP_ID,
    enrollmentDate: null,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: T0,
    updatedAt: T0,
  });
}

const GUARDIAN_ID = '22222222-0000-0000-0000-000000000008';
function aGuardian(): ChildGuardian {
  return ChildGuardian.createPending({
    id: GUARDIAN_ID,
    kindergartenId: KindergartenId.parse(KG_A),
    childId: ChildId.parse(CHILD_ID),
    userId: UserId.parse('99999999-0000-0000-0000-000000000099'),
    role: GuardianRelation.PRIMARY,
    canPickup: true,
    now: T0,
  });
}

function makeService(now: Date = T0) {
  const enrollmentRepo = new FakeEnrollmentRepository();
  const logRepo = new FakeEnrollmentStatusLogRepository();
  const childService = new StubChildService();
  const groupRepo = new FakeGroupRepo();
  const staffRepo = new FakeStaffRepo();
  const invoiceService = new StubInvoiceService();
  const clock = new FixedClock(now);
  const service = new EnrollmentService(
    enrollmentRepo,
    logRepo,
    childService as unknown as ChildService,
    groupRepo,
    staffRepo,
    invoiceService as unknown as InvoiceService,
    clock,
  );
  return {
    service,
    enrollmentRepo,
    logRepo,
    childService,
    groupRepo,
    staffRepo,
    invoiceService,
    clock,
  };
}

function seedNewEnrollment(
  enrollmentRepo: FakeEnrollmentRepository,
  clock: ClockPort,
  overrides: Partial<{
    childName: string | null;
    childDob: Date | null;
    contactName: string;
    contactPhone: string;
    childIin: string | null;
    assignedTo: string | null;
  }> = {},
): Enrollment {
  const enrollment = Enrollment.createNew(
    {
      kindergartenId: KG_A,
      contactName: overrides.contactName ?? 'Aigul Atayeva',
      contactPhone: overrides.contactPhone ?? '+77011112233',
      childName:
        overrides.childName === null
          ? undefined
          : (overrides.childName ?? 'Aliya Atayeva'),
      childDob:
        overrides.childDob === null
          ? undefined
          : (overrides.childDob ?? new Date('2021-08-15T00:00:00.000Z')),
      childIin: overrides.childIin === null ? undefined : overrides.childIin,
      assignedTo:
        overrides.assignedTo === null ? undefined : overrides.assignedTo,
    },
    clock,
    () => `enr-${enrollmentRepo.rows.size + 1}`,
  );
  enrollmentRepo.put(enrollment);
  return enrollment;
}

function seedAtStatus(
  enrollmentRepo: FakeEnrollmentRepository,
  status:
    | 'in_processing'
    | 'waitlist'
    | 'card_created'
    | 'cancelled'
    | 'archive',
  overrides: Partial<{
    childName: string | null;
    childDob: Date | null;
    childId: string | null;
    contactName: string;
    contactPhone: string;
  }> = {},
): Enrollment {
  const id = `enr-${enrollmentRepo.rows.size + 1}`;
  const e = Enrollment.hydrate({
    id,
    kindergartenId: KG_A,
    childId: overrides.childId ?? null,
    contactName: overrides.contactName ?? 'Aigul Atayeva',
    contactPhone: overrides.contactPhone ?? '+77011112233',
    childName:
      overrides.childName === null
        ? null
        : (overrides.childName ?? 'Aliya Atayeva'),
    childDob:
      overrides.childDob === null
        ? null
        : (overrides.childDob ?? new Date('2021-08-15T00:00:00.000Z')),
    childIin: null,
    status,
    source: null,
    notes: null,
    assignedTo: null,
    statusChangedAt: T0,
    createdAt: T0,
    updatedAt: T0,
  });
  enrollmentRepo.put(e);
  return e;
}

// ── tests ────────────────────────────────────────────────────────────────

describe('EnrollmentService', () => {
  describe('create', () => {
    it('returns a new enrollment with `new` status and persists it', async () => {
      const { service, enrollmentRepo } = makeService();
      const result = await service.create(
        KG_A,
        {
          contactName: 'Aigul Atayeva',
          contactPhone: '+77011112233',
        },
        STAFF_USER_ID,
      );
      expect(result.kindergartenId).toBe(KG_A);
      expect(result.status.value).toBe('new');
      expect(result.contactName).toBe('Aigul Atayeva');
      expect(enrollmentRepo.rows.size).toBe(1);
    });

    it('accepts assignedTo when staff exists in the same kindergarten', async () => {
      const { service, staffRepo } = makeService();
      staffRepo.put(aStaff(ASSIGNED_STAFF_ID, 'some-other-user', KG_A));
      const result = await service.create(
        KG_A,
        {
          contactName: 'Aigul',
          contactPhone: '+77011112233',
          assignedTo: ASSIGNED_STAFF_ID,
        },
        STAFF_USER_ID,
      );
      expect(result.assignedTo).toBe(ASSIGNED_STAFF_ID);
    });

    it('throws StaffNotFoundError when assignedTo refers to unknown staff', async () => {
      const { service } = makeService();
      await expect(
        service.create(
          KG_A,
          {
            contactName: 'Aigul',
            contactPhone: '+77011112233',
            assignedTo: ASSIGNED_STAFF_ID,
          },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });

    it('throws StaffNotFoundError when assignedTo points at a different kindergarten', async () => {
      const { service, staffRepo } = makeService();
      staffRepo.put(aStaff(ASSIGNED_STAFF_ID, 'user-x', KG_B));
      await expect(
        service.create(
          KG_A,
          {
            contactName: 'Aigul',
            contactPhone: '+77011112233',
            assignedTo: ASSIGNED_STAFF_ID,
          },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });

    it('does NOT write a log entry on initial creation', async () => {
      const { service, logRepo } = makeService();
      await service.create(
        KG_A,
        { contactName: 'Aigul', contactPhone: '+77011112233' },
        STAFF_USER_ID,
      );
      expect(logRepo.rows).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('returns EnrollmentNotFoundError for unknown id', async () => {
      const { service } = makeService();
      await expect(
        service.update(KG_A, 'no-such', { contactName: 'X' }),
      ).rejects.toBeInstanceOf(EnrollmentNotFoundError);
    });

    it('updates editable fields', async () => {
      const { service, enrollmentRepo, clock } = makeService();
      const e = await seedNewEnrollment(enrollmentRepo, clock);
      const updated = await service.update(KG_A, e.id, {
        contactName: 'Aigul New',
        notes: 'changed mind',
      });
      expect(updated.contactName).toBe('Aigul New');
      expect(updated.notes).toBe('changed mind');
    });

    it('throws EnrollmentLockedError when status is card_created', async () => {
      const { service, enrollmentRepo } = makeService();
      const e = await seedAtStatus(enrollmentRepo, 'card_created', {
        childId: CHILD_ID,
      });
      await expect(
        service.update(KG_A, e.id, { contactName: 'Z' }),
      ).rejects.toBeInstanceOf(EnrollmentLockedError);
    });

    it('throws EnrollmentLockedError when status is archive', async () => {
      const { service, enrollmentRepo } = makeService();
      const e = await seedAtStatus(enrollmentRepo, 'archive');
      await expect(
        service.update(KG_A, e.id, { contactName: 'Z' }),
      ).rejects.toBeInstanceOf(EnrollmentLockedError);
    });

    it('throws StaffNotFoundError when patch.assignedTo is unknown', async () => {
      const { service, enrollmentRepo, clock } = makeService();
      const e = await seedNewEnrollment(enrollmentRepo, clock);
      await expect(
        service.update(KG_A, e.id, { assignedTo: ASSIGNED_STAFF_ID }),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });
  });

  describe('getById', () => {
    it('returns the enrollment together with its log (newest-first)', async () => {
      const { service, enrollmentRepo, logRepo, clock } = makeService();
      const e = await seedNewEnrollment(enrollmentRepo, clock);
      await logRepo.append(KG_A, {
        enrollmentId: e.id,
        kindergartenId: KG_A,
        fromStatus: 'new',
        toStatus: 'in_processing',
        changedBy: STAFF_MEMBER_ID,
        comment: null,
        createdAt: new Date('2026-04-30T11:00:00.000Z'),
      });
      await logRepo.append(KG_A, {
        enrollmentId: e.id,
        kindergartenId: KG_A,
        fromStatus: 'in_processing',
        toStatus: 'waitlist',
        changedBy: STAFF_MEMBER_ID,
        comment: null,
        createdAt: new Date('2026-04-30T12:00:00.000Z'),
      });
      const out = await service.getById(KG_A, e.id);
      expect(out.enrollment.id).toBe(e.id);
      expect(out.log).toHaveLength(2);
      expect(out.log[0].toStatus).toBe('waitlist');
      expect(out.log[1].toStatus).toBe('in_processing');
    });

    it('throws EnrollmentNotFoundError for unknown id', async () => {
      const { service } = makeService();
      await expect(service.getById(KG_A, 'no-such')).rejects.toBeInstanceOf(
        EnrollmentNotFoundError,
      );
    });
  });

  describe('list', () => {
    it('filters by status and paginates', async () => {
      const { service, enrollmentRepo } = makeService();
      // Seed 3 in `new` and 2 in `waitlist`.
      for (let i = 0; i < 3; i++) {
        await seedAtStatus(enrollmentRepo, 'in_processing');
      }
      for (let i = 0; i < 2; i++) {
        await seedAtStatus(enrollmentRepo, 'waitlist');
      }
      const all = await service.list(KG_A, {});
      expect(all.total).toBe(5);
      expect(all.page).toBe(1);
      expect(all.limit).toBe(20);

      const onlyWaitlist = await service.list(KG_A, { status: 'waitlist' });
      expect(onlyWaitlist.total).toBe(2);
      expect(
        onlyWaitlist.items.every((e) => e.status.value === 'waitlist'),
      ).toBe(true);
    });

    it('uses defaults (page=1, limit=20) when query omits them', async () => {
      const { service } = makeService();
      const result = await service.list(KG_A, {});
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });
  });

  describe('transition', () => {
    it('returns EnrollmentNotFoundError for unknown id', async () => {
      const { service } = makeService();
      await expect(
        service.transition(
          KG_A,
          'no-such',
          { toStatus: 'in_processing' },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(EnrollmentNotFoundError);
    });

    it('throws StaffNotFoundError when caller has no active staff record', async () => {
      const { service, enrollmentRepo, clock } = makeService();
      const e = await seedNewEnrollment(enrollmentRepo, clock);
      await expect(
        service.transition(
          KG_A,
          e.id,
          { toStatus: 'in_processing' },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });

    it('records a log entry for new -> in_processing', async () => {
      const { service, enrollmentRepo, logRepo, staffRepo, clock } =
        makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      const e = await seedNewEnrollment(enrollmentRepo, clock);
      const out = await service.transition(
        KG_A,
        e.id,
        { toStatus: 'in_processing', comment: 'called the parent' },
        STAFF_USER_ID,
      );
      expect(out.enrollment.status.value).toBe('in_processing');
      expect(out.child).toBeUndefined();
      expect(logRepo.rows).toHaveLength(1);
      expect(logRepo.rows[0].fromStatus).toBe('new');
      expect(logRepo.rows[0].toStatus).toBe('in_processing');
      expect(logRepo.rows[0].changedBy).toBe(STAFF_MEMBER_ID);
      expect(logRepo.rows[0].comment).toBe('called the parent');
    });

    it('records a log entry for in_processing -> waitlist', async () => {
      const { service, enrollmentRepo, logRepo, staffRepo } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing');
      const out = await service.transition(
        KG_A,
        e.id,
        { toStatus: 'waitlist' },
        STAFF_USER_ID,
      );
      expect(out.enrollment.status.value).toBe('waitlist');
      expect(logRepo.rows).toHaveLength(1);
      expect(logRepo.rows[0].toStatus).toBe('waitlist');
    });

    it('rejects new -> card_created (skipping in_processing)', async () => {
      const { service, enrollmentRepo, staffRepo, groupRepo, clock } =
        makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      groupRepo.put(aGroup(GROUP_ID, KG_A));
      const e = await seedNewEnrollment(enrollmentRepo, clock);
      await expect(
        service.transition(
          KG_A,
          e.id,
          { toStatus: 'card_created', currentGroupId: GROUP_ID },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(InvalidEnrollmentStatusTransitionError);
    });

    it('rejects in_processing -> card_created when currentGroupId is missing', async () => {
      const { service, enrollmentRepo, staffRepo } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing');
      await expect(
        service.transition(
          KG_A,
          e.id,
          { toStatus: 'card_created' },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(EnrollmentMissingRequiredFieldsError);
    });

    it('rejects in_processing -> card_created when childDob is null', async () => {
      const { service, enrollmentRepo, staffRepo, groupRepo } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      groupRepo.put(aGroup(GROUP_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing', {
        childDob: null,
      });
      await expect(
        service.transition(
          KG_A,
          e.id,
          { toStatus: 'card_created', currentGroupId: GROUP_ID },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(EnrollmentMissingRequiredFieldsError);
    });

    it('rejects in_processing -> card_created when group is unknown', async () => {
      const { service, enrollmentRepo, staffRepo } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing');
      await expect(
        service.transition(
          KG_A,
          e.id,
          { toStatus: 'card_created', currentGroupId: GROUP_ID },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(GroupNotFoundError);
    });

    it('happy-path in_processing -> card_created creates child + invites primary guardian + assigns + generates first invoice', async () => {
      const {
        service,
        enrollmentRepo,
        logRepo,
        staffRepo,
        groupRepo,
        childService,
        invoiceService,
      } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      groupRepo.put(aGroup(GROUP_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing', {
        childName: 'Aliya Atayeva',
        contactPhone: '+77011112233',
      });
      childService.childToReturn = aChild(CHILD_ID, KG_A);
      childService.guardianToReturn = aGuardian();

      const out = await service.transition(
        KG_A,
        e.id,
        { toStatus: 'card_created', currentGroupId: GROUP_ID },
        STAFF_USER_ID,
      );

      expect(out.enrollment.status.value).toBe('card_created');
      expect(out.enrollment.childId).toBe(CHILD_ID);
      expect(out.child!.id).toBe(CHILD_ID);

      expect(childService.createChildCalls).toHaveLength(1);
      const cc = childService.createChildCalls[0];
      expect(cc.kindergartenId).toBe(KG_A);
      expect(cc.fullName).toBe('Aliya Atayeva');
      expect(cc.currentGroupId).toBe(GROUP_ID);
      expect(cc.dateOfBirth).toEqual(new Date('2021-08-15T00:00:00.000Z'));

      expect(childService.inviteGuardianCalls).toHaveLength(1);
      const ig = childService.inviteGuardianCalls[0];
      expect(ig.kindergartenId).toBe(KG_A);
      expect(ig.childId).toBe(CHILD_ID);
      expect(ig.role).toBe('primary');
      expect(ig.canPickup).toBe(true);
      expect(ig.userPhone).toBe('+77011112233');
      expect(ig.invitedByUserId).toBe(STAFF_USER_ID);

      expect(logRepo.rows).toHaveLength(1);
      expect(logRepo.rows[0].fromStatus).toBe('in_processing');
      expect(logRepo.rows[0].toStatus).toBe('card_created');
      expect(logRepo.rows[0].changedBy).toBe(STAFF_MEMBER_ID);

      // B13 cross-module hook — first-month invoice on card_created.
      expect(invoiceService.generateFirstInvoiceCalls).toHaveLength(1);
      const inv = invoiceService.generateFirstInvoiceCalls[0];
      expect(inv.kindergartenId).toBe(KG_A);
      expect(inv.childId).toBe(CHILD_ID);
      expect(inv.assignedBy).toBe(STAFF_MEMBER_ID);
      expect(inv.enrollmentDate).toEqual(T0);
    });

    it('completes transition (lax mode) when first-invoice generation throws TariffAssignmentNotFoundError (no tariff yet)', async () => {
      const {
        service,
        enrollmentRepo,
        logRepo,
        staffRepo,
        groupRepo,
        childService,
        invoiceService,
      } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      groupRepo.put(aGroup(GROUP_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing', {
        childName: 'Aliya Atayeva',
        contactPhone: '+77011112233',
      });
      childService.childToReturn = aChild(CHILD_ID, KG_A);
      childService.guardianToReturn = aGuardian();
      invoiceService.errorToThrow = new TariffAssignmentNotFoundError(CHILD_ID);

      // Lax mode: tariff_assignment requires child_id which only exists after
      // createChild in this same TX, so on the very first card_created
      // transition there cannot be an assignment. The hook logs + skips
      // instead of rolling back, allowing the admin to attach a tariff
      // post-creation and let the next monthly cron generate the invoice.
      const result = await service.transition(
        KG_A,
        e.id,
        { toStatus: 'card_created', currentGroupId: GROUP_ID },
        STAFF_USER_ID,
      );
      expect(result.enrollment.status.value).toBe('card_created');
      expect(invoiceService.generateFirstInvoiceCalls).toHaveLength(1);
      expect(logRepo.rows).toHaveLength(1);
    });

    it('rolls back transition when first-invoice generation throws an unexpected error', async () => {
      const {
        service,
        enrollmentRepo,
        logRepo,
        staffRepo,
        groupRepo,
        childService,
        invoiceService,
      } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      groupRepo.put(aGroup(GROUP_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing', {
        childName: 'Aliya Atayeva',
        contactPhone: '+77011112233',
      });
      childService.childToReturn = aChild(CHILD_ID, KG_A);
      childService.guardianToReturn = aGuardian();
      invoiceService.errorToThrow = new Error('unexpected db error');

      await expect(
        service.transition(
          KG_A,
          e.id,
          { toStatus: 'card_created', currentGroupId: GROUP_ID },
          STAFF_USER_ID,
        ),
      ).rejects.toThrow('unexpected db error');

      // Non-TariffAssignmentNotFoundError still propagates → ambient TX rollback.
      expect(invoiceService.generateFirstInvoiceCalls).toHaveLength(1);
      expect(logRepo.rows).toHaveLength(0);
    });

    it('does NOT generate first invoice for transitions to non-card_created targets', async () => {
      const { service, enrollmentRepo, staffRepo, invoiceService } =
        makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing');
      await service.transition(
        KG_A,
        e.id,
        { toStatus: 'waitlist' },
        STAFF_USER_ID,
      );
      expect(invoiceService.generateFirstInvoiceCalls).toHaveLength(0);
    });

    it('throws EnrollmentTransitionConflictError when status-guarded UPDATE returns false', async () => {
      const {
        service,
        enrollmentRepo,
        logRepo,
        staffRepo,
        groupRepo,
        childService,
      } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      groupRepo.put(aGroup(GROUP_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'in_processing', {
        childName: 'Aliya Atayeva',
        contactPhone: '+77011112233',
      });
      childService.childToReturn = aChild(CHILD_ID, KG_A);
      childService.guardianToReturn = aGuardian();

      // Simulate a concurrent transition having already moved the row.
      enrollmentRepo.forceConflictOnce.add(e.id);

      await expect(
        service.transition(
          KG_A,
          e.id,
          { toStatus: 'card_created', currentGroupId: GROUP_ID },
          STAFF_USER_ID,
        ),
      ).rejects.toBeInstanceOf(EnrollmentTransitionConflictError);

      // Log entry was NOT appended because the conflict aborted the flow
      // BEFORE logRepo.append (in production this is what the ambient TX
      // rollback also takes care of for the createChild/inviteGuardian
      // writes that DID run before the conflict surfaced).
      expect(logRepo.rows).toHaveLength(0);
    });

    it('records card_created -> archive without invoking ChildService', async () => {
      const { service, enrollmentRepo, logRepo, staffRepo, childService } =
        makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'card_created', {
        childId: CHILD_ID,
      });
      const out = await service.transition(
        KG_A,
        e.id,
        { toStatus: 'archive' },
        STAFF_USER_ID,
      );
      expect(out.enrollment.status.value).toBe('archive');
      expect(out.child).toBeUndefined();
      expect(childService.createChildCalls).toHaveLength(0);
      expect(childService.inviteGuardianCalls).toHaveLength(0);
      expect(logRepo.rows).toHaveLength(1);
    });
  });

  describe('assign', () => {
    it('reassigns the lead to a valid staff member', async () => {
      const { service, enrollmentRepo, staffRepo, clock } = makeService();
      staffRepo.put(aStaff(STAFF_MEMBER_ID, STAFF_USER_ID, KG_A));
      staffRepo.put(aStaff(ASSIGNED_STAFF_ID, 'user-other', KG_A));
      const e = await seedNewEnrollment(enrollmentRepo, clock);
      const out = await service.assign(KG_A, e.id, {
        assignedTo: ASSIGNED_STAFF_ID,
      });
      expect(out.assignedTo).toBe(ASSIGNED_STAFF_ID);
    });

    it('throws StaffNotFoundError when assignedTo belongs to another kindergarten', async () => {
      const { service, enrollmentRepo, staffRepo, clock } = makeService();
      staffRepo.put(aStaff(ASSIGNED_STAFF_ID, 'user-other', KG_B));
      const e = await seedNewEnrollment(enrollmentRepo, clock);
      await expect(
        service.assign(KG_A, e.id, { assignedTo: ASSIGNED_STAFF_ID }),
      ).rejects.toBeInstanceOf(StaffNotFoundError);
    });

    it('throws EnrollmentLockedError when status is archive', async () => {
      const { service, enrollmentRepo, staffRepo } = makeService();
      staffRepo.put(aStaff(ASSIGNED_STAFF_ID, 'user-other', KG_A));
      const e = await seedAtStatus(enrollmentRepo, 'archive');
      await expect(
        service.assign(KG_A, e.id, { assignedTo: ASSIGNED_STAFF_ID }),
      ).rejects.toBeInstanceOf(EnrollmentLockedError);
    });

    it('returns EnrollmentNotFoundError for unknown id', async () => {
      const { service } = makeService();
      await expect(
        service.assign(KG_A, 'no-such', { assignedTo: ASSIGNED_STAFF_ID }),
      ).rejects.toBeInstanceOf(EnrollmentNotFoundError);
    });
  });
});
