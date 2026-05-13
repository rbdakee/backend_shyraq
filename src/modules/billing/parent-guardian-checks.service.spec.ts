/**
 * Service-unit coverage for the guardian re-checks moved out of the parent
 * billing controllers in B22b T3 (H18 — controllers→service refactor).
 *
 *   - `InvoiceService.assertNonNannyGuardianForRead` — folded from
 *     `ParentInvoiceController.assertNonNannyGuardian`.
 *   - `PaymentService.assertCanPay` — folded from
 *     `ParentPaymentController.assertCanPay`.
 *
 * The full builders for InvoiceService / PaymentService live in their
 * sibling specs; here we only construct the minimum needed to exercise the
 * new methods. `findApprovedActiveByUserAndChild` is the only port method
 * touched, so the fake ChildGuardianRepository is intentionally thin.
 */
import { ForbiddenException } from '@nestjs/common';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { GuardianPermissions } from '@/shared-kernel/domain/value-objects/guardian-permissions.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { GuardianStatus } from '@/shared-kernel/domain/value-objects/guardian-status.vo';
import { InvoiceService } from './invoice.service';
import { PaymentService } from './payment.service';

const KG_A = '11111111-1111-1111-1111-111111111111';
const KG_B = '22222222-2222-2222-2222-222222222222';
const USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const CHILD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const NOW = new Date('2026-06-01T09:00:00.000Z');

function makeGuardian(
  role: 'primary' | 'secondary' | 'nanny',
  permissions: Record<string, boolean> = {},
): ChildGuardian {
  return ChildGuardian.hydrate({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    kindergartenId: KG_A,
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

  // Only the assert paths call `findApprovedActiveByUserAndChild`.
  findApprovedActiveByUserAndChild(
    kindergartenId: string,
    childId: string,
    userId: string,
  ): Promise<ChildGuardian | null> {
    if (!this.store) return Promise.resolve(null);
    // `KindergartenId` / `ChildId` / `UserId` are branded strings — compare
    // as strings directly.
    if (
      (this.store.kindergartenId as string) !== kindergartenId ||
      (this.store.childId as string) !== childId ||
      (this.store.userId as string) !== userId
    ) {
      return Promise.resolve(null);
    }
    return Promise.resolve(this.store);
  }

  // Remaining abstract methods are never called in this spec — provide
  // minimal stubs so the fake instantiates.
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

function buildInvoiceServiceWithGuardian(guardian: ChildGuardian | null): {
  svc: InvoiceService;
  guardians: FakeChildGuardianRepo;
} {
  const guardians = new FakeChildGuardianRepo();
  guardians.store = guardian;
  // The first 10 args are unused by `assertNonNannyGuardianForRead` — any
  // truthy stub is fine. We pass `null as unknown as <Port>` to keep the
  // call signature satisfied without wiring real fakes for unrelated deps.
  const stub = null as unknown as never;
  const svc = new InvoiceService(
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    undefined,
    undefined,
    undefined,
    undefined,
    guardians,
  );
  return { svc, guardians };
}

function buildPaymentServiceWithGuardian(guardian: ChildGuardian | null): {
  svc: PaymentService;
  guardians: FakeChildGuardianRepo;
} {
  const guardians = new FakeChildGuardianRepo();
  guardians.store = guardian;
  const stub = null as unknown as never;
  const svc = new PaymentService(
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    guardians,
  );
  return { svc, guardians };
}

// ─────────────────────────────────────────────────────────────────────────

describe('InvoiceService.assertNonNannyGuardianForRead', () => {
  it('returns void for an approved-active primary guardian', async () => {
    const { svc } = buildInvoiceServiceWithGuardian(makeGuardian('primary'));
    await expect(
      svc.assertNonNannyGuardianForRead(KG_A, USER, CHILD),
    ).resolves.toBeUndefined();
  });

  it('returns void for an approved-active secondary guardian', async () => {
    const { svc } = buildInvoiceServiceWithGuardian(makeGuardian('secondary'));
    await expect(
      svc.assertNonNannyGuardianForRead(KG_A, USER, CHILD),
    ).resolves.toBeUndefined();
  });

  it('throws ForbiddenException("not_a_guardian") when the user has no link', async () => {
    const { svc } = buildInvoiceServiceWithGuardian(null);
    await expect(
      svc.assertNonNannyGuardianForRead(KG_A, USER, CHILD),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      svc.assertNonNannyGuardianForRead(KG_A, USER, CHILD),
    ).rejects.toThrow('not_a_guardian');
  });

  it('throws ForbiddenException("nanny_cannot_view_invoice") for nanny role', async () => {
    const { svc } = buildInvoiceServiceWithGuardian(makeGuardian('nanny'));
    await expect(
      svc.assertNonNannyGuardianForRead(KG_A, USER, CHILD),
    ).rejects.toThrow('nanny_cannot_view_invoice');
  });

  it('rejects cross-tenant: link exists in kg_A, request comes in for kg_B', async () => {
    // store the guardian under kg_A, then ask the service to check kg_B.
    const { svc } = buildInvoiceServiceWithGuardian(makeGuardian('primary'));
    await expect(
      svc.assertNonNannyGuardianForRead(KG_B, USER, CHILD),
    ).rejects.toThrow('not_a_guardian');
  });

  it('fails closed when ChildGuardianRepository port is unwired', async () => {
    const stub = null as unknown as never;
    const svc = new InvoiceService(
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
    );
    await expect(
      svc.assertNonNannyGuardianForRead(KG_A, USER, CHILD),
    ).rejects.toThrow('not_a_guardian');
  });
});

describe('PaymentService.assertCanPay', () => {
  it('returns void for an approved-active primary guardian with default permissions', async () => {
    const { svc } = buildPaymentServiceWithGuardian(makeGuardian('primary'));
    await expect(svc.assertCanPay(KG_A, USER, CHILD)).resolves.toBeUndefined();
  });

  it('returns void for secondary with default pay_invoices=true', async () => {
    const { svc } = buildPaymentServiceWithGuardian(makeGuardian('secondary'));
    await expect(svc.assertCanPay(KG_A, USER, CHILD)).resolves.toBeUndefined();
  });

  it('throws ForbiddenException("not_a_guardian") when no link', async () => {
    const { svc } = buildPaymentServiceWithGuardian(null);
    await expect(svc.assertCanPay(KG_A, USER, CHILD)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(svc.assertCanPay(KG_A, USER, CHILD)).rejects.toThrow(
      'not_a_guardian',
    );
  });

  it('throws ForbiddenException("nanny_cannot_pay") for nanny role', async () => {
    const { svc } = buildPaymentServiceWithGuardian(makeGuardian('nanny'));
    await expect(svc.assertCanPay(KG_A, USER, CHILD)).rejects.toThrow(
      'nanny_cannot_pay',
    );
  });

  it('throws ForbiddenException("secondary_pay_not_allowed") when primary revoked pay_invoices on the row', async () => {
    const { svc } = buildPaymentServiceWithGuardian(
      makeGuardian('secondary', { pay_invoices: false }),
    );
    await expect(svc.assertCanPay(KG_A, USER, CHILD)).rejects.toThrow(
      'secondary_pay_not_allowed',
    );
  });

  it('rejects cross-tenant request (kg_A link, kg_B request)', async () => {
    const { svc } = buildPaymentServiceWithGuardian(makeGuardian('primary'));
    await expect(svc.assertCanPay(KG_B, USER, CHILD)).rejects.toThrow(
      'not_a_guardian',
    );
  });

  it('fails closed when ChildGuardianRepository port is unwired', async () => {
    const stub = null as unknown as never;
    const svc = new PaymentService(
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
      stub,
    );
    await expect(svc.assertCanPay(KG_A, USER, CHILD)).rejects.toThrow(
      'not_a_guardian',
    );
  });
});

// Sanity check on the GuardianPermissions VO that the assert relies on —
// double-checks default semantics so a future VO change can't silently
// flip these.
describe('GuardianPermissions defaults (sanity)', () => {
  const make = (role: 'primary' | 'secondary' | 'nanny'): boolean => {
    const perms = GuardianPermissions.fromObject({});
    return (
      perms.effective(GuardianRelation.fromString(role)).pay_invoices ?? false
    );
  };
  // `pay_invoices` defaults: primary/secondary true, nanny false.
  void GuardianStatus; // ensure the import is exercised even when unused
  it('primary defaults pay_invoices=true', () => {
    expect(make('primary')).toBe(true);
  });
  it('secondary defaults pay_invoices=true', () => {
    expect(make('secondary')).toBe(true);
  });
  it('nanny defaults pay_invoices=false', () => {
    expect(make('nanny')).toBe(false);
  });
});
