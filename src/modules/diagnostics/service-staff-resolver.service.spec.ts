/**
 * Service-unit coverage for the staff-member resolvers + parent permission
 * gate that B22b T3 moved out of the diagnostics controllers.
 *
 *   - `DiagnosticTemplateService.findStaffMemberByUserIdOrThrow`
 *   - `DiagnosticEntryService.findStaffMemberByUserIdOrThrow`
 *   - `DiagnosticEntryService.assertParentCanViewDiagnostics`
 *   - `ProgressNoteService.findStaffMemberByUserIdOrThrow`
 *   - `MyTodosService.findStaffMemberByUserIdOrThrow`
 *   - `ParentRequestService.resolveCallerByUserIdOrThrow` is covered by
 *     parent-request.service.spec.ts (its existing fixture already wires
 *     `StaffMemberRepository`).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { StaffMember } from '@/modules/staff/domain/entities/staff-member.entity';
import {
  CreateStaffMemberInput,
  ListStaffFilters,
  StaffMemberRepository,
  UpdateStaffMemberInput,
} from '@/modules/staff/infrastructure/persistence/staff-member.repository';
import { DiagnosticEntryService } from './diagnostic-entry.service';
import { DiagnosticTemplateService } from './diagnostic-template.service';
import { MyTodosService } from './my-todos.service';
import { NannyNoDiagnosticsAccessError } from './domain/errors/nanny-no-diagnostics-access.error';
import { ProgressNoteService } from './progress-note.service';

const KG = '11111111-1111-1111-1111-111111111111';
const KG_OTHER = '22222222-2222-2222-2222-222222222222';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NOW = new Date('2026-06-01T09:00:00.000Z');

function makeStaffMember(
  role: 'admin' | 'mentor' | 'specialist' | 'reception' = 'admin',
): StaffMember {
  // role=specialist requires a non-null specialist_type from the whitelist;
  // other roles must have specialist_type=null (StaffMember validateRoleMatrix
  // invariant).
  const specialistType = role === 'specialist' ? 'speech_therapist' : null;
  return StaffMember.hydrate({
    id: 'ffffffff-1111-2222-3333-ffffffffffff',
    kindergartenId: KG,
    userId: USER,
    fullName: 'Adam Admin',
    phone: '+77001234567',
    role,
    specialistType,
    isActive: true,
    hiredAt: NOW,
    firedAt: null,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

class FakeStaffRepo extends StaffMemberRepository {
  store: StaffMember | null = null;

  findActiveByUserAndKindergarten(
    userId: string,
    kindergartenId: string,
  ): Promise<StaffMember | null> {
    if (!this.store) return Promise.resolve(null);
    if (
      this.store.userId !== userId ||
      this.store.kindergartenId !== kindergartenId
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.store);
  }
  // Remaining abstract stubs.
  create(_: CreateStaffMemberInput): Promise<StaffMember> {
    return Promise.reject(new Error('unused'));
  }
  findById(): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  listByKindergarten(
    _: string,
    __?: ListStaffFilters,
  ): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
  update(
    _: string,
    __: string,
    ___: UpdateStaffMemberInput,
  ): Promise<StaffMember | null> {
    return Promise.resolve(null);
  }
  save(_: StaffMember): Promise<StaffMember> {
    return Promise.reject(new Error('unused'));
  }
  deactivateAllByKindergarten(): Promise<number> {
    return Promise.resolve(0);
  }
  findAllActiveByUserId(): Promise<StaffMember[]> {
    return Promise.resolve([]);
  }
}

function makeGuardian(
  role: 'primary' | 'secondary' | 'nanny',
  permissions: Record<string, boolean> = {},
): ChildGuardian {
  return ChildGuardian.hydrate({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    kindergartenId: KG,
    childId: CHILD,
    userId: USER,
    role,
    status: 'approved',
    hasApprovalRights: false,
    approvedBy: null,
    approvedAt: NOW,
    revokedBy: null,
    revokedAt: null,
    canPickup: true,
    permissions,
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

class FakeChildGuardianRepo extends ChildGuardianRepository {
  store: ChildGuardian | null = null;

  findApprovedActiveByUserAndChild(
    kindergartenId: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    if (!this.store) return Promise.resolve(null);
    if (
      (this.store.kindergartenId as string) !== kindergartenId ||
      (this.store.childId as string) !== childId ||
      (this.store.userId as string) !== userId
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.store);
  }
  create(): Promise<void> {
    return Promise.resolve();
  }
  findById(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByChildId(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findActiveByChildAndUser(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedByChildAndUserCrossTenant(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findByIdCrossTenant(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findPendingForPrimary(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
  countApprovalRights(): Promise<number> {
    return Promise.resolve(0);
  }
  acquireApprovalRightsLock(): Promise<void> {
    return Promise.resolve();
  }
  listApprovedKindergartenIdsByUserId(): Promise<string[]> {
    return Promise.resolve([]);
  }
  findApprovedByUser(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findPendingPrimaryByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
  findApprovedActivePickupGuardian(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
  findApprovedActiveByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    return Promise.resolve([]);
  }
}

// ─────────────────────────────────────────────────────────────────────────

const stub = null as unknown as never;

describe('DiagnosticTemplateService.findStaffMemberByUserIdOrThrow', () => {
  it('returns the active staff_member when found', async () => {
    const staffRepo = new FakeStaffRepo();
    staffRepo.store = makeStaffMember();
    const svc = new DiagnosticTemplateService(stub, stub, staffRepo);
    const sm = await svc.findStaffMemberByUserIdOrThrow(KG, USER);
    expect(sm.id).toBe('ffffffff-1111-2222-3333-ffffffffffff');
  });

  it('throws NotFoundException when no row exists', async () => {
    const staffRepo = new FakeStaffRepo();
    const svc = new DiagnosticTemplateService(stub, stub, staffRepo);
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG, USER),
    ).rejects.toThrow(NotFoundException);
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG, USER),
    ).rejects.toThrow('staff_member_not_found');
  });

  it('throws NotFoundException for cross-tenant: kg_A staff, kg_B request', async () => {
    const staffRepo = new FakeStaffRepo();
    staffRepo.store = makeStaffMember();
    const svc = new DiagnosticTemplateService(stub, stub, staffRepo);
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG_OTHER, USER),
    ).rejects.toThrow('staff_member_not_found');
  });

  it('fails closed when the port is unwired', async () => {
    const svc = new DiagnosticTemplateService(stub, stub);
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG, USER),
    ).rejects.toThrow('staff_member_not_found');
  });
});

describe('DiagnosticEntryService.findStaffMemberByUserIdOrThrow', () => {
  it('returns the active staff_member when found', async () => {
    const staffRepo = new FakeStaffRepo();
    staffRepo.store = makeStaffMember('specialist');
    // 5 required deps unused by this path → stub them.
    const svc = new DiagnosticEntryService(
      stub,
      stub,
      stub,
      stub,
      stub,
      staffRepo,
    );
    const sm = await svc.findStaffMemberByUserIdOrThrow(KG, USER);
    expect(sm.id).toBe('ffffffff-1111-2222-3333-ffffffffffff');
  });

  it('throws when missing', async () => {
    const staffRepo = new FakeStaffRepo();
    const svc = new DiagnosticEntryService(
      stub,
      stub,
      stub,
      stub,
      stub,
      staffRepo,
    );
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG, USER),
    ).rejects.toThrow('staff_member_not_found');
  });
});

describe('DiagnosticEntryService.assertParentCanViewDiagnostics', () => {
  it('returns void for an approved-active primary guardian', async () => {
    const guardians = new FakeChildGuardianRepo();
    guardians.store = makeGuardian('primary');
    const svc = new DiagnosticEntryService(
      stub,
      stub,
      stub,
      stub,
      stub,
      undefined,
      guardians,
    );
    await expect(
      svc.assertParentCanViewDiagnostics(KG, USER, CHILD),
    ).resolves.toBeUndefined();
  });

  it('throws ForbiddenException("not_a_guardian") when no link', async () => {
    const guardians = new FakeChildGuardianRepo();
    const svc = new DiagnosticEntryService(
      stub,
      stub,
      stub,
      stub,
      stub,
      undefined,
      guardians,
    );
    await expect(
      svc.assertParentCanViewDiagnostics(KG, USER, CHILD),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.assertParentCanViewDiagnostics(KG, USER, CHILD),
    ).rejects.toThrow('not_a_guardian');
  });

  it('throws NannyNoDiagnosticsAccessError for nanny role', async () => {
    const guardians = new FakeChildGuardianRepo();
    guardians.store = makeGuardian('nanny');
    const svc = new DiagnosticEntryService(
      stub,
      stub,
      stub,
      stub,
      stub,
      undefined,
      guardians,
    );
    await expect(
      svc.assertParentCanViewDiagnostics(KG, USER, CHILD),
    ).rejects.toThrow(NannyNoDiagnosticsAccessError);
  });

  it('throws NannyNoDiagnosticsAccessError when secondary has view_diagnostics=false', async () => {
    const guardians = new FakeChildGuardianRepo();
    guardians.store = makeGuardian('secondary', { view_diagnostics: false });
    const svc = new DiagnosticEntryService(
      stub,
      stub,
      stub,
      stub,
      stub,
      undefined,
      guardians,
    );
    await expect(
      svc.assertParentCanViewDiagnostics(KG, USER, CHILD),
    ).rejects.toThrow(NannyNoDiagnosticsAccessError);
  });

  it('rejects cross-tenant: kg_A link, kg_B request → not_a_guardian', async () => {
    const guardians = new FakeChildGuardianRepo();
    guardians.store = makeGuardian('primary');
    const svc = new DiagnosticEntryService(
      stub,
      stub,
      stub,
      stub,
      stub,
      undefined,
      guardians,
    );
    await expect(
      svc.assertParentCanViewDiagnostics(KG_OTHER, USER, CHILD),
    ).rejects.toThrow('not_a_guardian');
  });

  it('fails closed when childGuardians port is unwired', async () => {
    const svc = new DiagnosticEntryService(stub, stub, stub, stub, stub);
    await expect(
      svc.assertParentCanViewDiagnostics(KG, USER, CHILD),
    ).rejects.toThrow('not_a_guardian');
  });
});

describe('ProgressNoteService.findStaffMemberByUserIdOrThrow', () => {
  it('returns the active staff_member', async () => {
    const staffRepo = new FakeStaffRepo();
    staffRepo.store = makeStaffMember('mentor');
    const svc = new ProgressNoteService(stub, stub, stub, stub, staffRepo);
    const sm = await svc.findStaffMemberByUserIdOrThrow(KG, USER);
    expect(sm.role).toBe('mentor');
  });

  it('throws when missing', async () => {
    const staffRepo = new FakeStaffRepo();
    const svc = new ProgressNoteService(stub, stub, stub, stub, staffRepo);
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG, USER),
    ).rejects.toThrow('staff_member_not_found');
  });

  it('fails closed when port unwired', async () => {
    const svc = new ProgressNoteService(stub, stub, stub, stub);
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG, USER),
    ).rejects.toThrow('staff_member_not_found');
  });
});

describe('MyTodosService.findStaffMemberByUserIdOrThrow', () => {
  it('returns the active staff_member', async () => {
    const staffRepo = new FakeStaffRepo();
    staffRepo.store = makeStaffMember('specialist');
    const svc = new MyTodosService(stub, stub, stub, staffRepo);
    const sm = await svc.findStaffMemberByUserIdOrThrow(KG, USER);
    expect(sm.role).toBe('specialist');
  });

  it('throws when missing', async () => {
    const staffRepo = new FakeStaffRepo();
    const svc = new MyTodosService(stub, stub, stub, staffRepo);
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG, USER),
    ).rejects.toThrow('staff_member_not_found');
  });

  it('fails closed when port unwired', async () => {
    const svc = new MyTodosService(stub, stub, stub);
    await expect(
      svc.findStaffMemberByUserIdOrThrow(KG, USER),
    ).rejects.toThrow('staff_member_not_found');
  });
});
