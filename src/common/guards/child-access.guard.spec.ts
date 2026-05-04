import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildAccessGuard } from './child-access.guard';

const KG_A = '11111111-1111-1111-1111-111111111111';
const KG_B = '22222222-2222-2222-2222-222222222222';
const CHILD_A = '33333333-3333-3333-3333-333333333333';
const CHILD_B = '44444444-4444-4444-4444-444444444444';
const PARENT = '55555555-5555-5555-5555-555555555555';
const NOW = new Date('2026-04-28T12:00:00.000Z');

interface ReqShape {
  user?: { sub: string; role: string; kindergarten_id?: string | null };
  params: Record<string, string | undefined>;
  tenant?: { kgId: string | null; bypass: boolean };
  guardianRecord?: ChildGuardian;
}

function makeCtx(req: ReqShape): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeApprovedGuardian(args: {
  id: string;
  kg: string;
  childId: string;
  userId: string;
}): ChildGuardian {
  return ChildGuardian.hydrate({
    id: args.id,
    kindergartenId: args.kg,
    childId: args.childId,
    userId: args.userId,
    role: 'primary',
    status: 'approved',
    hasApprovalRights: true,
    approvedBy: args.userId,
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

class FakeRepo extends ChildGuardianRepository {
  constructor(private readonly rows: ChildGuardian[]) {
    super();
  }
  findApprovedByChildAndUserCrossTenant(
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    const r = this.rows.find(
      (x) =>
        x.childId === childId &&
        x.userId === userId &&
        x.status.value === 'approved',
    );
    return Promise.resolve(r ?? null);
  }
  findByIdCrossTenant(id: string): Promise<ChildGuardian | null> {
    return Promise.resolve(this.rows.find((x) => x.id === id) ?? null);
  }
  // Unused stubs — must be present because the abstract class declares them.
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
  findApprovedActiveByUserAndChild(): Promise<ChildGuardian | null> {
    return Promise.resolve(null);
  }
}

describe('ChildAccessGuard', () => {
  it('returns true and sets req.tenant from the resolved guardian on :id route', async () => {
    const g = makeApprovedGuardian({
      id: 'g1',
      kg: KG_A,
      childId: CHILD_A,
      userId: PARENT,
    });
    const guard = new ChildAccessGuard(new FakeRepo([g]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent' },
      params: { id: CHILD_A },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_A, bypass: false });
    expect(req.guardianRecord?.id).toBe('g1');
  });

  it('throws ForbiddenException when caller has no approved guardian on the child', async () => {
    const guard = new ChildAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent' },
      params: { id: CHILD_A },
    };
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(req.tenant).toBeUndefined();
    expect(req.guardianRecord).toBeUndefined();
  });

  it('resolves childId from :guardianId then sets req.tenant', async () => {
    const g = makeApprovedGuardian({
      id: 'g2',
      kg: KG_B,
      childId: CHILD_B,
      userId: PARENT,
    });
    const guard = new ChildAccessGuard(new FakeRepo([g]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent' },
      params: { guardianId: 'g2' },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_B, bypass: false });
  });

  it('returns true without touching req.tenant for routes without :childId/:guardianId (listMine path)', async () => {
    const guard = new ChildAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent' },
      params: {},
      // simulate KindergartenScopeGuard already setting tenant from JWT —
      // ChildAccessGuard must NOT clobber it.
      tenant: { kgId: KG_A, bypass: false },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_A, bypass: false });
    expect(req.guardianRecord).toBeUndefined();
  });

  it('skips for non-parent roles (admin/staff use RolesGuard)', async () => {
    const guard = new ChildAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'admin', kindergarten_id: KG_A },
      params: { id: CHILD_A },
      tenant: { kgId: KG_A, bypass: false },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_A, bypass: false });
    expect(req.guardianRecord).toBeUndefined();
  });
});
