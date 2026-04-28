import { randomUUID } from 'node:crypto';
import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { GuardianPermissions } from '@/shared-kernel/domain/value-objects/guardian-permissions.vo';
import { GuardianRelation } from '@/shared-kernel/domain/value-objects/guardian-relation.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { UserId } from '@/shared-kernel/domain/value-objects/user-id.vo';
import { ChildGuardian } from './child-guardian.entity';
import { GuardianNotApprovedError } from '../errors/guardian-not-approved.error';
import { InvalidGuardianStatusTransitionError } from '../errors/invalid-guardian-status-transition.error';

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
