/**
 * WsAutoSubscribeService — service-unit suite (B9 follow-up).
 *
 * Verifies that the WS auto-subscribe room set is derived from the
 * JWT's `role` + `kindergarten_id` claims and never widens beyond what
 * the handshake authorises. Each scenario uses hand-written in-memory
 * fakes for the cross-tenant guardian / mentor lookups (no DB, no Nest
 * runtime). The fakes assert that the kg filter is actually passed
 * through to the repository — that's the load-bearing piece of the
 * fix.
 */
import type { Socket } from 'socket.io';
import type { VerifiedAccessClaims } from '@/modules/auth/jwt-token.port';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { GroupMentor } from '@/modules/group/domain/entities/group-mentor.entity';
import { GroupRepository } from '@/modules/group/infrastructure/persistence/group.repository';
import { WsAutoSubscribeService } from './ws-auto-subscribe.service';

const KG_A = '11111111-1111-1111-1111-111111111111';
const KG_B = '22222222-2222-2222-2222-222222222222';
const USER = '99999999-9999-9999-9999-999999999999';
const CHILD_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CHILD_OTHER = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const GROUP_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const GROUP_OTHER = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const GROUP_LEAK = '12345678-1234-1234-1234-123456789abc';

class FakeSocket {
  id = 'sock-1';
  joined: string[] = [];
  // socket.join must support both string and string[] but our impl
  // calls it once per room — single-string fast path is enough.
  join(room: string | string[]): Promise<void> {
    if (Array.isArray(room)) this.joined.push(...room);
    else this.joined.push(room);
    return Promise.resolve();
  }
}

class FakeGuardianRepo extends ChildGuardianRepository {
  rows: ChildGuardian[] = [];
  lastCalled: { userId: string; kindergartenId?: string } | null = null;

  // ── port surface — only the WS path matters; everything else throws. ──
  create(): Promise<void> {
    throw new Error('not impl');
  }
  findById(): Promise<ChildGuardian | null> {
    throw new Error('not impl');
  }
  findByChildId(): Promise<ChildGuardian[]> {
    throw new Error('not impl');
  }
  findActiveByChildAndUser(): Promise<ChildGuardian | null> {
    throw new Error('not impl');
  }
  findApprovedByChildAndUserCrossTenant(): Promise<ChildGuardian | null> {
    throw new Error('not impl');
  }
  findByIdCrossTenant(): Promise<ChildGuardian | null> {
    throw new Error('not impl');
  }
  findPendingForPrimary(): Promise<ChildGuardian[]> {
    throw new Error('not impl');
  }
  update(): Promise<void> {
    throw new Error('not impl');
  }
  countApprovalRights(): Promise<number> {
    throw new Error('not impl');
  }
  listApprovedKindergartenIdsByUserId(): Promise<string[]> {
    throw new Error('not impl');
  }
  findApprovedByUser(): Promise<ChildGuardian[]> {
    throw new Error('not impl');
  }
  findPendingPrimaryByUserIdCrossTenant(): Promise<ChildGuardian[]> {
    throw new Error('not impl');
  }
  findApprovedActivePickupGuardian(): Promise<ChildGuardian | null> {
    throw new Error('not impl');
  }

  findApprovedActiveByUserIdCrossTenant(
    userId: string,
    kindergartenId?: string,
  ): Promise<ChildGuardian[]> {
    this.lastCalled = { userId, kindergartenId };
    const filtered = kindergartenId
      ? this.rows.filter((r) => r.toState().kindergartenId === kindergartenId)
      : this.rows;
    return Promise.resolve(filtered);
  }
}

class FakeGroupRepo extends GroupRepository {
  rows: GroupMentor[] = [];
  lastCalled: { userId: string; kindergartenId?: string } | null = null;

  // ── port surface — only the WS path matters; everything else throws. ──
  create(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }
  findById(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }
  list(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }
  update(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }
  save(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }
  assignMentor(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }
  unassignMentor(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }
  findActiveMentor(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }
  listMentorHistory(): Promise<never> {
    return Promise.reject(new Error('not impl'));
  }

  findActiveMentorAssignmentsByUserIdCrossTenant(
    userId: string,
    kindergartenId?: string,
  ): Promise<GroupMentor[]> {
    this.lastCalled = { userId, kindergartenId };
    const filtered = kindergartenId
      ? this.rows.filter((r) => r.toState().kindergartenId === kindergartenId)
      : this.rows;
    return Promise.resolve(filtered);
  }
}

// Stable UUID for the guardian/mentor PKs — entity hydrate enforces UUID
// shape on `id`. We don't care about uniqueness across rows for this
// suite; the WS subscribe path keys on childId / groupId, not row id.
const STUB_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const STUB_STAFF_UUID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function approvedGuardian(
  childId: string,
  kgId: string,
  userId: string,
): ChildGuardian {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return ChildGuardian.hydrate({
    id: STUB_UUID,
    kindergartenId: kgId,
    childId,
    userId,
    role: 'primary',
    status: 'approved',
    hasApprovalRights: true,
    approvedBy: userId,
    approvedAt: now,
    revokedBy: null,
    revokedAt: null,
    canPickup: false,
    permissions: {},
    permissionsUpdatedBy: null,
    permissionsUpdatedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

function activeMentor(groupId: string, kgId: string): GroupMentor {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return GroupMentor.hydrate({
    id: STUB_UUID,
    kindergartenId: kgId,
    groupId,
    staffMemberId: STUB_STAFF_UUID,
    isPrimary: true,
    assignedAt: now,
    unassignedAt: null,
    createdAt: now,
  });
}

function makeService(): {
  svc: WsAutoSubscribeService;
  guardians: FakeGuardianRepo;
  groups: FakeGroupRepo;
  socket: FakeSocket;
} {
  const guardians = new FakeGuardianRepo();
  const groups = new FakeGroupRepo();
  const svc = new WsAutoSubscribeService(guardians, groups);
  const socket = new FakeSocket();
  return { svc, guardians, groups, socket };
}

function claims(over: Partial<VerifiedAccessClaims>): VerifiedAccessClaims {
  return {
    sub: USER,
    role: 'parent',
    kindergarten_id: KG_A,
    pending_role_select: false,
    jti: 'jti-1',
    ...over,
  };
}

describe('WsAutoSubscribeService.subscribe', () => {
  it('parent JWT → joins user:{id} + child:{cid} only for the JWT kg, ignoring other-tenant guardian rows', async () => {
    const { svc, guardians, groups, socket } = makeService();
    // User has approved guardian rows in BOTH kg_A (JWT scope) and kg_B
    // (mixed-account scenario). Only kg_A should bleed into the room set.
    guardians.rows.push(approvedGuardian(CHILD_A, KG_A, USER));
    guardians.rows.push(approvedGuardian(CHILD_OTHER, KG_B, USER));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({ role: 'parent', kindergarten_id: KG_A }),
    );

    expect(rooms.sort()).toEqual([`child:${CHILD_A}`, `user:${USER}`].sort());
    // Filter pushed through to the repo — load-bearing piece of the fix.
    expect(guardians.lastCalled).toEqual({
      userId: USER,
      kindergartenId: KG_A,
    });
    // No staff lookups for parent role.
    expect(groups.lastCalled).toBeNull();
    // Socket actually joined.
    expect(socket.joined.sort()).toEqual(rooms.sort());
  });

  it('staff JWT → joins user:{id} + group:{gid} only for the JWT kg', async () => {
    const { svc, guardians, groups, socket } = makeService();
    groups.rows.push(activeMentor(GROUP_A, KG_A));
    groups.rows.push(activeMentor(GROUP_OTHER, KG_B));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({ role: 'staff', kindergarten_id: KG_A }),
    );

    expect(rooms.sort()).toEqual([`group:${GROUP_A}`, `user:${USER}`].sort());
    expect(groups.lastCalled).toEqual({ userId: USER, kindergartenId: KG_A });
    expect(guardians.lastCalled).toBeNull();
  });

  it('admin JWT → behaves as staff (joins group:{gid} for kg)', async () => {
    const { svc, guardians, groups, socket } = makeService();
    groups.rows.push(activeMentor(GROUP_A, KG_A));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({ role: 'admin', kindergarten_id: KG_A }),
    );

    expect(rooms).toEqual([`user:${USER}`, `group:${GROUP_A}`]);
    expect(groups.lastCalled).toEqual({ userId: USER, kindergartenId: KG_A });
    expect(guardians.lastCalled).toBeNull();
  });

  it('mixed parent+staff account with a kg_A parent JWT → joins only child:* rooms in kg_A; kg_B group rooms are NOT joined', async () => {
    const { svc, guardians, groups, socket } = makeService();
    // Parent in kg_A.
    guardians.rows.push(approvedGuardian(CHILD_A, KG_A, USER));
    // Same user is also a mentor in kg_B (the bug scenario).
    groups.rows.push(activeMentor(GROUP_LEAK, KG_B));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({ role: 'parent', kindergarten_id: KG_A }),
    );

    expect(rooms.sort()).toEqual([`child:${CHILD_A}`, `user:${USER}`].sort());
    // Critically: NO group:* room from kg_B — JWT role is parent.
    expect(rooms.find((r) => r.startsWith('group:'))).toBeUndefined();
    // And no staff lookup at all — parent role short-circuits the mentor path.
    expect(groups.lastCalled).toBeNull();
  });

  it('super_admin JWT → joins only user:{id}, no kg-scoped rooms (no leakage even with mentor/guardian rows)', async () => {
    const { svc, guardians, groups, socket } = makeService();
    guardians.rows.push(approvedGuardian(CHILD_A, KG_A, USER));
    groups.rows.push(activeMentor(GROUP_A, KG_A));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({ role: 'super_admin', kindergarten_id: null }),
    );

    expect(rooms).toEqual([`user:${USER}`]);
    expect(guardians.lastCalled).toBeNull();
    expect(groups.lastCalled).toBeNull();
  });

  it('pending_role_select=true → only user:{id}, regardless of role/kg', async () => {
    const { svc, guardians, groups, socket } = makeService();
    guardians.rows.push(approvedGuardian(CHILD_A, KG_A, USER));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({
        role: 'parent',
        kindergarten_id: KG_A,
        pending_role_select: true,
      }),
    );

    expect(rooms).toEqual([`user:${USER}`]);
    expect(guardians.lastCalled).toBeNull();
    expect(groups.lastCalled).toBeNull();
  });

  it('null kindergarten_id → only user:{id} (no kg context, no kg-scoped rooms)', async () => {
    const { svc, guardians, groups, socket } = makeService();
    guardians.rows.push(approvedGuardian(CHILD_A, KG_A, USER));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({ role: 'parent', kindergarten_id: null }),
    );

    expect(rooms).toEqual([`user:${USER}`]);
    expect(guardians.lastCalled).toBeNull();
    expect(groups.lastCalled).toBeNull();
  });

  it('parent with no guardian rows in their kg → only user:{id}', async () => {
    const { svc, guardians, socket } = makeService();
    // Guardian row exists but in a DIFFERENT kg from the JWT.
    guardians.rows.push(approvedGuardian(CHILD_A, KG_B, USER));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({ role: 'parent', kindergarten_id: KG_A }),
    );

    expect(rooms).toEqual([`user:${USER}`]);
    expect(guardians.lastCalled).toEqual({
      userId: USER,
      kindergartenId: KG_A,
    });
  });

  it('unknown / future role → only user:{id} (fail closed)', async () => {
    const { svc, guardians, groups, socket } = makeService();
    guardians.rows.push(approvedGuardian(CHILD_A, KG_A, USER));
    groups.rows.push(activeMentor(GROUP_A, KG_A));

    const { rooms } = await svc.subscribe(
      socket as unknown as Socket,
      claims({ role: 'mystery_role_2030', kindergarten_id: KG_A }),
    );

    expect(rooms).toEqual([`user:${USER}`]);
    expect(guardians.lastCalled).toBeNull();
    expect(groups.lastCalled).toBeNull();
  });
});
