import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { TrustedPerson } from '@/modules/pickup/domain/entities/trusted-person.entity';
import {
  CreateTrustedPersonRow,
  TrustedPersonPatch,
  TrustedPersonRepository,
} from '@/modules/pickup/infrastructure/persistence/trusted-person.repository';
import { TrustedPersonAccessGuard } from './trusted-person-access.guard';

const KG_B = '22222222-2222-2222-2222-222222222222';
const CHILD_B = '44444444-4444-4444-4444-444444444444';
const PARENT = '55555555-5555-5555-5555-555555555555';
const TP_ID = '88888888-8888-8888-8888-888888888888';
const NOW = new Date('2026-06-12T12:00:00.000Z');

interface ReqShape {
  user?: { sub: string; role: string; kindergarten_id?: string | null };
  params: Record<string, string | undefined>;
  tenant?: { kgId: string | null; bypass: boolean };
}

function makeCtx(req: ReqShape): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function makeTrustedPerson(args: {
  id: string;
  kg: string;
  childId: string;
}): TrustedPerson {
  return TrustedPerson.create({
    id: args.id,
    kindergartenId: args.kg,
    childId: args.childId,
    addedByUserId: PARENT,
    fullName: 'Айгуль Бекмаганбетова',
    phone: '+77071234567',
    iin: null,
    relation: 'aunt',
    photoUrl: null,
    isOneTime: false,
    createdAt: NOW,
  });
}

class FakeRepo extends TrustedPersonRepository {
  constructor(private readonly rows: TrustedPerson[]) {
    super();
  }
  override findByIdCrossTenant(id: string): Promise<TrustedPerson | null> {
    return Promise.resolve(this.rows.find((tp) => tp.id === id) ?? null);
  }
  // Unused abstract stubs.
  create(_input: CreateTrustedPersonRow): Promise<TrustedPerson> {
    return Promise.reject(new Error('unused'));
  }
  findById(): Promise<TrustedPerson | null> {
    return Promise.resolve(null);
  }
  listByChild(): Promise<TrustedPerson[]> {
    return Promise.resolve([]);
  }
  update(
    _id: string,
    _patch: TrustedPersonPatch,
  ): Promise<TrustedPerson | null> {
    return Promise.resolve(null);
  }
  markRevoked(): Promise<void> {
    return Promise.resolve();
  }
  markUsed(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

describe('TrustedPersonAccessGuard', () => {
  it('pins req.tenant to the kg of the trusted_person resolved by :id (resource in another kg)', async () => {
    // Unscoped parent JWT; the row lives in KG_B. The guard resolves the kg
    // from the resource and pins it — no token-kg. Ownership is enforced by the
    // service afterwards (defense-in-depth).
    const tp = makeTrustedPerson({ id: TP_ID, kg: KG_B, childId: CHILD_B });
    const guard = new TrustedPersonAccessGuard(new FakeRepo([tp]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent', kindergarten_id: null },
      params: { id: TP_ID },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_B, bypass: false });
  });

  it('throws NotFoundException when the id resolves to no trusted_person anywhere', async () => {
    const guard = new TrustedPersonAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent', kindergarten_id: null },
      params: { id: TP_ID },
    };
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(req.tenant).toBeUndefined();
  });

  it('skips for non-parent roles without clobbering req.tenant', async () => {
    const guard = new TrustedPersonAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'admin', kindergarten_id: KG_B },
      params: { id: TP_ID },
      tenant: { kgId: KG_B, bypass: false },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_B, bypass: false });
  });

  it('passes through when there is no :id param', async () => {
    const guard = new TrustedPersonAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent', kindergarten_id: null },
      params: {},
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toBeUndefined();
  });
});
