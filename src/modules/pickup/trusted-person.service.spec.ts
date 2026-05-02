/**
 * TrustedPersonService — service-unit suite. Hand-written in-memory fakes.
 *
 * Coverage matrix:
 *   - listByChild: returns rows when caller is approved-active guardian
 *   - listByChild: throws ForbiddenActionError when caller has no link
 *   - listByChild: throws ForbiddenActionError when link is not approved
 *   - addByParent: returns new row with addedByUserId set to caller
 *   - addByParent: ChildNotFoundError when child missing
 *   - update: returns patched row when caller is the original adder
 *   - update: returns patched row when caller is approved-active guardian
 *   - update: ForbiddenActionError when caller has no relationship
 *   - revoke: returns revoked row
 *   - revoke: TrustedPersonNotFoundError when row missing / cross-tenant
 */
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { Child } from '@/modules/child/domain/entities/child.entity';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import {
  ChildGroupHistoryRecord,
  ChildListFilters,
  ChildRepository,
  PageRequest,
  PageResult,
} from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import { TrustedPerson } from './domain/entities/trusted-person.entity';
import { TrustedPersonNotFoundError } from './domain/errors/trusted-person-not-found.error';
import {
  CreateTrustedPersonRow,
  TrustedPersonPatch,
  TrustedPersonRepository,
} from './infrastructure/persistence/trusted-person.repository';
import { TrustedPersonService } from './trusted-person.service';

const KG = '11111111-1111-1111-1111-111111111111';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const PARENT_USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const OTHER_USER = 'aaaaaaaa-9999-9999-9999-aaaaaaaaaaaa';
const TP_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const NOW = new Date('2026-05-01T09:00:00.000Z');

class FixedClock extends ClockPort {
  constructor(private fixed: Date) {
    super();
  }
  now(): Date {
    return this.fixed;
  }
}

class FakeTrustedPersonRepo extends TrustedPersonRepository {
  rows = new Map<string, TrustedPerson>();
  put(tp: TrustedPerson): void {
    this.rows.set(tp.id, tp);
  }
  create(input: CreateTrustedPersonRow): Promise<TrustedPerson> {
    const tp = TrustedPerson.create({
      id: `tp-${this.rows.size + 1}`,
      kindergartenId: input.kindergartenId,
      childId: input.childId,
      addedByUserId: input.addedByUserId,
      fullName: input.fullName,
      phone: input.phone,
      iin: input.iin,
      relation: input.relation,
      photoUrl: input.photoUrl,
      isOneTime: input.isOneTime,
      createdAt: NOW,
    });
    this.rows.set(tp.id, tp);
    return Promise.resolve(tp);
  }
  findById(id: string): Promise<TrustedPerson | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  listByChild(_kg: string, _cid: string): Promise<TrustedPerson[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  update(id: string, patch: TrustedPersonPatch): Promise<TrustedPerson | null> {
    const tp = this.rows.get(id);
    if (!tp) return Promise.resolve(null);
    // Re-hydrate with patch applied — minimal fake.
    const s = tp.toState();
    const next = TrustedPerson.fromState({
      ...s,
      fullName: patch.fullName ?? s.fullName,
      phone: patch.phone ?? s.phone,
      iin: patch.iin !== undefined ? patch.iin : s.iin,
      relation: patch.relation ?? s.relation,
      photoUrl: patch.photoUrl !== undefined ? patch.photoUrl : s.photoUrl,
      isOneTime: patch.isOneTime ?? s.isOneTime,
    });
    this.rows.set(id, next);
    return Promise.resolve(next);
  }
  markRevoked(id: string, now: Date): Promise<void> {
    const tp = this.rows.get(id);
    if (tp) this.rows.set(id, tp.revoke(now));
    return Promise.resolve();
  }
  markUsed(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeChildGuardianRepo extends ChildGuardianRepository {
  rows: ChildGuardian[] = [];
  put(g: ChildGuardian): void {
    this.rows.push(g);
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
  findActiveByChildAndUser(
    kg: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const r =
      this.rows.find((g) => {
        const s = g.toState();
        return (
          s.kindergartenId === kg &&
          s.childId === childId &&
          s.userId === userId &&
          s.status !== 'revoked'
        );
      }) ?? null;
    return Promise.resolve(r);
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

class FakeChildRepo extends ChildRepository {
  byId = new Map<string, Child>();
  put(c: Child): void {
    this.byId.set(c.id, c);
  }
  create(): Promise<void> {
    return Promise.resolve();
  }
  findById(_kg: string, id: string): Promise<Child | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }
  findByKindergartenAndIin(): Promise<Child | null> {
    return Promise.resolve(null);
  }
  update(): Promise<void> {
    return Promise.resolve();
  }
  list(
    _kg: string,
    _f: ChildListFilters,
    _p: PageRequest,
  ): Promise<PageResult<Child>> {
    return Promise.resolve({ items: [], total: 0 });
  }
  countActiveByGroup(): Promise<number> {
    return Promise.resolve(0);
  }
  recordGroupTransfer(): Promise<void> {
    return Promise.resolve();
  }
  listGroupHistory(): Promise<ChildGroupHistoryRecord[]> {
    return Promise.resolve([]);
  }
  findByIinCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
  findByIdsCrossTenant(): Promise<Child[]> {
    return Promise.resolve([]);
  }
}

function makeChild(): Child {
  return Child.hydrate({
    id: CHILD,
    kindergartenId: KG,
    iin: null,
    fullName: 'Test Child',
    dateOfBirth: new Date('2022-01-01'),
    gender: null,
    photoUrl: null,
    status: 'active',
    currentGroupId: null,
    enrollmentDate: NOW,
    archivedAt: null,
    archiveReason: null,
    medicalNotes: null,
    allergyNotes: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeApprovedGuardian(userId: string): ChildGuardian {
  return ChildGuardian.hydrate({
    id: `g-${userId}`,
    kindergartenId: KG,
    childId: CHILD,
    userId,
    role: 'primary',
    status: 'approved',
    hasApprovalRights: true,
    approvedBy: userId,
    approvedAt: NOW,
    revokedBy: null,
    revokedAt: null,
    canPickup: true,
    permissions: {},
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeRevokedGuardian(userId: string): ChildGuardian {
  return ChildGuardian.hydrate({
    id: `g-revoked-${userId}`,
    kindergartenId: KG,
    childId: CHILD,
    userId,
    role: 'primary',
    status: 'approved',
    hasApprovalRights: true,
    approvedBy: userId,
    approvedAt: NOW,
    revokedBy: userId,
    revokedAt: NOW,
    canPickup: true,
    permissions: {},
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makePendingGuardian(userId: string): ChildGuardian {
  return ChildGuardian.hydrate({
    id: `g-pending-${userId}`,
    kindergartenId: KG,
    childId: CHILD,
    userId,
    role: 'secondary',
    status: 'pending_approval',
    hasApprovalRights: false,
    approvedBy: null,
    approvedAt: null,
    revokedBy: null,
    revokedAt: null,
    canPickup: false,
    permissions: {},
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeTrustedPerson(addedBy: string = PARENT_USER): TrustedPerson {
  return TrustedPerson.fromState({
    id: TP_ID,
    kindergartenId: KG,
    childId: CHILD,
    addedByUserId: addedBy,
    fullName: 'Айгуль',
    phone: '+77071234567',
    iin: null,
    relation: 'aunt',
    photoUrl: null,
    isActive: true,
    isOneTime: false,
    usedAt: null,
    createdAt: NOW,
    revokedAt: null,
  });
}

interface Wired {
  service: TrustedPersonService;
  trustedPeople: FakeTrustedPersonRepo;
  guardians: FakeChildGuardianRepo;
  children: FakeChildRepo;
  clock: FixedClock;
}

function wire(): Wired {
  const trustedPeople = new FakeTrustedPersonRepo();
  const guardians = new FakeChildGuardianRepo();
  const children = new FakeChildRepo();
  const clock = new FixedClock(NOW);
  children.put(makeChild());
  const service = new TrustedPersonService(
    trustedPeople,
    guardians,
    children,
    clock,
  );
  return { service, trustedPeople, guardians, children, clock };
}

describe('TrustedPersonService — service-unit', () => {
  describe('listByChild', () => {
    it('returns rows when the caller is an approved-active guardian', async () => {
      const w = wire();
      w.guardians.put(makeApprovedGuardian(PARENT_USER));
      w.trustedPeople.put(makeTrustedPerson());
      const items = await w.service.listByChild(KG, CHILD, PARENT_USER);
      expect(items).toHaveLength(1);
    });

    it('throws ForbiddenActionError when the caller has no guardian link', async () => {
      const w = wire();
      await expect(
        w.service.listByChild(KG, CHILD, PARENT_USER),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });

    it('throws ForbiddenActionError when the link is pending_approval', async () => {
      const w = wire();
      w.guardians.put(makePendingGuardian(PARENT_USER));
      await expect(
        w.service.listByChild(KG, CHILD, PARENT_USER),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });

    it('throws ChildNotFoundError when the child does not exist in this kg', async () => {
      const w = wire();
      w.guardians.put(makeApprovedGuardian(PARENT_USER));
      await expect(
        w.service.listByChild(
          KG,
          'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          PARENT_USER,
        ),
      ).rejects.toBeInstanceOf(ChildNotFoundError);
    });
  });

  describe('addByParent', () => {
    it('returns a new row with addedByUserId set to the caller', async () => {
      const w = wire();
      w.guardians.put(makeApprovedGuardian(PARENT_USER));
      const tp = await w.service.addByParent(KG, CHILD, PARENT_USER, {
        fullName: 'Aunt',
        phone: '+77001112233',
        iin: null,
        relation: 'aunt',
        photoUrl: null,
        isOneTime: false,
      });
      expect(tp.addedByUserId).toBe(PARENT_USER);
      expect(tp.fullName).toBe('Aunt');
    });

    it('throws ForbiddenActionError when the caller is not a guardian', async () => {
      const w = wire();
      await expect(
        w.service.addByParent(KG, CHILD, PARENT_USER, {
          fullName: 'Aunt',
          phone: '+77001112233',
          iin: null,
          relation: 'aunt',
          photoUrl: null,
          isOneTime: false,
        }),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });
  });

  describe('update', () => {
    it('returns the patched row when the caller is an approved-active guardian on the same child', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson(OTHER_USER));
      w.guardians.put(makeApprovedGuardian(PARENT_USER));
      const updated = await w.service.update(KG, TP_ID, PARENT_USER, {
        relation: 'driver',
      });
      expect(updated.relation).toBe('driver');
    });

    it('returns the patched row when caller is original adder AND still an active guardian', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson(PARENT_USER));
      w.guardians.put(makeApprovedGuardian(PARENT_USER));
      const updated = await w.service.update(KG, TP_ID, PARENT_USER, {
        fullName: 'Aunt Renamed',
      });
      expect(updated.fullName).toBe('Aunt Renamed');
    });

    it('throws ForbiddenActionError when original adder is no longer a guardian (T7 M5 fix — addedByUserId no longer authorizes)', async () => {
      const w = wire();
      // PARENT_USER added the row but is NOT currently a guardian.
      w.trustedPeople.put(makeTrustedPerson(PARENT_USER));
      await expect(
        w.service.update(KG, TP_ID, PARENT_USER, { fullName: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });

    it('throws ForbiddenActionError when the caller has no relationship', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson(OTHER_USER));
      await expect(
        w.service.update(KG, TP_ID, PARENT_USER, { fullName: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });

    it('throws TrustedPersonNotFoundError when the row is missing', async () => {
      const w = wire();
      await expect(
        w.service.update(KG, 'nope', PARENT_USER, { fullName: 'X' }),
      ).rejects.toBeInstanceOf(TrustedPersonNotFoundError);
    });
  });

  describe('revoke', () => {
    it('returns the revoked row when caller is original adder AND still an active guardian', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson(PARENT_USER));
      w.guardians.put(makeApprovedGuardian(PARENT_USER));
      const revoked = await w.service.revoke(KG, TP_ID, PARENT_USER);
      expect(revoked.isRevoked()).toBe(true);
      expect(revoked.isActive).toBe(false);
    });

    it('throws ForbiddenActionError when an ex-guardian (revoked link) tries to revoke a row they originally added (T7 M5 fix)', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson(PARENT_USER));
      // Guardian link exists but is revoked → assertCallerCanManage must
      // reject. Without the M5 fix the addedByUserId short-circuit would
      // still let this call succeed.
      w.guardians.put(makeRevokedGuardian(PARENT_USER));
      await expect(
        w.service.revoke(KG, TP_ID, PARENT_USER),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });

    it('throws TrustedPersonNotFoundError when the row is in a different kg', async () => {
      const w = wire();
      // Row is in KG; we ask for it from a different kg.
      w.trustedPeople.put(makeTrustedPerson(PARENT_USER));
      await expect(
        w.service.revoke(
          '99999999-9999-9999-9999-999999999999',
          TP_ID,
          PARENT_USER,
        ),
      ).rejects.toBeInstanceOf(TrustedPersonNotFoundError);
    });

    it('throws ForbiddenActionError when the caller has no relationship', async () => {
      const w = wire();
      w.trustedPeople.put(makeTrustedPerson(OTHER_USER));
      await expect(
        w.service.revoke(KG, TP_ID, PARENT_USER),
      ).rejects.toBeInstanceOf(ForbiddenActionError);
    });
  });
});
