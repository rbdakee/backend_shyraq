import { ExecutionContext, NotFoundException } from '@nestjs/common';
import {
  ParentRequest,
  ParentRequestState,
} from '@/modules/parent-request/domain/entities/parent-request.entity';
import { ParentRequestRepository } from '@/modules/parent-request/parent-request.repository';
import { ParentRequestAccessGuard } from './parent-request-access.guard';

const KG_B = '22222222-2222-2222-2222-222222222222';
const CHILD_B = '44444444-4444-4444-4444-444444444444';
const PARENT = '55555555-5555-5555-5555-555555555555';
const REQ_ID = '66666666-6666-6666-6666-666666666666';
const NOW = new Date('2026-06-11T12:00:00.000Z');

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

function makeRequest(args: {
  id: string;
  kg: string;
  childId: string;
  requesterUserId: string;
}): ParentRequest {
  const state: ParentRequestState = {
    id: args.id,
    kindergartenId: args.kg,
    childId: args.childId,
    requesterUserId: args.requesterUserId,
    requestType: 'open_request',
    status: 'pending',
    dateFrom: null,
    dateTo: null,
    details: {},
    recipientType: 'admin',
    recipientStaffId: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    invoiceId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return ParentRequest.fromState(state);
}

class FakeRepo extends ParentRequestRepository {
  constructor(private readonly rows: ParentRequest[]) {
    super();
  }
  override findByIdCrossTenant(id: string): Promise<ParentRequest | null> {
    return Promise.resolve(this.rows.find((r) => r.id === id) ?? null);
  }
  // Unused abstract stubs.
  create(): Promise<ParentRequest> {
    return Promise.reject(new Error('unused'));
  }
  findById(): Promise<ParentRequest | null> {
    return Promise.resolve(null);
  }
  list(): Promise<ParentRequest[]> {
    return Promise.resolve([]);
  }
  updateStatusConditional(): Promise<ParentRequest | null> {
    return Promise.resolve(null);
  }
  setInvoiceId(): Promise<void> {
    return Promise.resolve();
  }
}

describe('ParentRequestAccessGuard', () => {
  it('pins req.tenant to the kg of the request resolved by :id (resource in another kg)', async () => {
    // Unscoped parent JWT; the request lives in KG_B. The guard resolves the
    // owning kg from the resource and pins it — no token-kg involved. It does
    // NOT enforce ownership (the service does); it only resolves the kg.
    const pr = makeRequest({
      id: REQ_ID,
      kg: KG_B,
      childId: CHILD_B,
      requesterUserId: PARENT,
    });
    const guard = new ParentRequestAccessGuard(new FakeRepo([pr]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent', kindergarten_id: null },
      params: { id: REQ_ID },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_B, bypass: false });
  });

  it('throws NotFoundException when the id resolves to no request anywhere', async () => {
    const guard = new ParentRequestAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent', kindergarten_id: null },
      params: { id: REQ_ID },
    };
    await expect(guard.canActivate(makeCtx(req))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(req.tenant).toBeUndefined();
  });

  it('returns true without pinning when there is no :id param', async () => {
    const guard = new ParentRequestAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'parent', kindergarten_id: null },
      params: {},
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toBeUndefined();
  });

  it('skips for non-parent roles without clobbering req.tenant', async () => {
    const guard = new ParentRequestAccessGuard(new FakeRepo([]));
    const req: ReqShape = {
      user: { sub: PARENT, role: 'admin', kindergarten_id: KG_B },
      params: { id: REQ_ID },
      tenant: { kgId: KG_B, bypass: false },
    };
    await expect(guard.canActivate(makeCtx(req))).resolves.toBe(true);
    expect(req.tenant).toEqual({ kgId: KG_B, bypass: false });
  });
});
