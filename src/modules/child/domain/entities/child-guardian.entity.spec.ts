import { randomUUID } from 'node:crypto';
import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { GuardianPermissions } from '@/shared-kernel/domain/value-objects/guardian-permissions.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { UserId } from '@/shared-kernel/domain/value-objects/user-id.vo';
import { ChildGuardian } from './child-guardian.entity';
import { GuardianNotApprovedError } from '../errors/guardian-not-approved.error';
import { InvalidGuardianStatusTransitionError } from '../errors/invalid-guardian-status-transition.error';
import { PrimaryCannotSelfUnlinkError } from '../errors/primary-cannot-self-unlink.error';

const KG = KindergartenId.parse('11111111-1111-1111-1111-111111111111');
const CHILD = ChildId.parse('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
const USER = UserId.parse('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
const PRIMARY = UserId.parse('cccccccc-cccc-cccc-cccc-cccccccccccc');
const NOW = new Date('2026-04-28T12:00:00.000Z');

function pending(): ChildGuardian {
  return ChildGuardian.createPending({
    id: randomUUID(),
    kindergartenId: KG,
    childId: CHILD,
    userId: USER,
    role: GuardianRelation.SECONDARY,
    now: NOW,
  });
}

function pendingPrimary(): ChildGuardian {
  return ChildGuardian.createPending({
    id: randomUUID(),
    kindergartenId: KG,
    childId: CHILD,
    userId: USER,
    role: GuardianRelation.PRIMARY,
    now: NOW,
  });
}

function pendingNanny(): ChildGuardian {
  return ChildGuardian.createPending({
    id: randomUUID(),
    kindergartenId: KG,
    childId: CHILD,
    userId: USER,
    role: GuardianRelation.NANNY,
    now: NOW,
  });
}

describe('ChildGuardian state machine', () => {
  it('approve from pending → approved', () => {
    const g = pending();
    g.approve(PRIMARY, NOW, false);
    expect(g.status.value).toBe('approved');
    expect(g.approvedBy).toBe(PRIMARY);
  });

  it('approve cannot run twice', () => {
    const g = pending();
    g.approve(PRIMARY, NOW, false);
    expect(() => g.approve(PRIMARY, NOW, false)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
  });

  it('reject from pending → rejected; cannot approve afterwards', () => {
    const g = pending();
    g.reject(NOW);
    expect(g.status.value).toBe('rejected');
    expect(() => g.approve(PRIMARY, NOW, false)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
  });

  it('revoke from approved → revoked; subsequent revoke fails', () => {
    const g = pending();
    g.approve(PRIMARY, NOW, false);
    g.revoke(PRIMARY, NOW);
    expect(g.status.value).toBe('revoked');
    expect(() => g.revoke(PRIMARY, NOW)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
  });

  it('updateRoleAndPickup is rejected on revoked rows', () => {
    const g = pending();
    g.approve(PRIMARY, NOW, false);
    g.revoke(PRIMARY, NOW);
    expect(() => g.updateRoleAndPickup({ canPickup: false }, NOW)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
  });

  it('applyPermissionsPatch requires status=approved', () => {
    const g = pending();
    expect(() =>
      g.applyPermissionsPatch(
        GuardianPermissions.fromObject({ view_cctv: false }),
        PRIMARY,
        NOW,
      ),
    ).toThrow(GuardianNotApprovedError);
  });

  it('applyPermissionsPatch merges overrides (toggleable keys)', () => {
    const g = pending();
    g.approve(PRIMARY, NOW, false);
    g.applyPermissionsPatch(
      GuardianPermissions.fromObject({ view_cctv: false }),
      PRIMARY,
      NOW,
    );
    expect(g.permissions.toJSON()).toEqual({ view_cctv: false });
    const eff = g.permissions.effective(g.role);
    expect(eff.view_cctv).toBe(false);
  });

  it('toggleApprovalRights requires approved', () => {
    const g = pending();
    expect(() => g.toggleApprovalRights(true, NOW)).toThrow(
      GuardianNotApprovedError,
    );
    g.approve(PRIMARY, NOW, false);
    g.toggleApprovalRights(true, NOW);
    expect(g.hasApprovalRights).toBe(true);
  });
});

describe('autoApproveAsPrimary', () => {
  it('approves a pending primary and sets has_approval_rights=true', () => {
    const g = pendingPrimary();
    g.autoApproveAsPrimary(NOW);
    expect(g.status.value).toBe('approved');
    expect(g.approvedAt).toBe(NOW);
    expect(g.approvedBy).toBe(USER);
    expect(g.hasApprovalRights).toBe(true);
    expect(g.updatedAt).toBe(NOW);
  });

  it('throws when role is not primary', () => {
    const secondary = pending();
    expect(() => secondary.autoApproveAsPrimary(NOW)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
    const nanny = pendingNanny();
    expect(() => nanny.autoApproveAsPrimary(NOW)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
  });

  it('throws when status is not pending_approval', () => {
    const g = pendingPrimary();
    g.autoApproveAsPrimary(NOW);
    // already approved → second auto-approve must reject
    expect(() => g.autoApproveAsPrimary(NOW)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
  });
});

describe('revokeBySelf', () => {
  it('revokes an approved secondary guardian and stamps revoked_by=self', () => {
    const g = pending();
    g.approve(PRIMARY, NOW, false);
    g.revokeBySelf(NOW);
    expect(g.status.value).toBe('revoked');
    expect(g.revokedAt).toBe(NOW);
    expect(g.revokedBy).toBe(USER);
    expect(g.updatedAt).toBe(NOW);
  });

  it('revokes an approved nanny guardian', () => {
    const g = pendingNanny();
    g.approve(PRIMARY, NOW, false);
    g.revokeBySelf(NOW);
    expect(g.status.value).toBe('revoked');
    expect(g.revokedBy).toBe(USER);
  });

  it('throws PrimaryCannotSelfUnlinkError when role is primary', () => {
    const g = pendingPrimary();
    g.autoApproveAsPrimary(NOW);
    expect(() => g.revokeBySelf(NOW)).toThrow(PrimaryCannotSelfUnlinkError);
  });

  it('throws when guardian is not approved (still pending)', () => {
    const g = pending();
    expect(() => g.revokeBySelf(NOW)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
  });

  it('throws when guardian is already revoked', () => {
    const g = pending();
    g.approve(PRIMARY, NOW, false);
    g.revokeBySelf(NOW);
    expect(() => g.revokeBySelf(NOW)).toThrow(
      InvalidGuardianStatusTransitionError,
    );
  });
});
