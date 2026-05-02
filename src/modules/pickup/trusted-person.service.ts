import { Inject, Injectable } from '@nestjs/common';
import { ChildGuardian } from '@/modules/child/domain/entities/child-guardian.entity';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import { TrustedPerson } from './domain/entities/trusted-person.entity';
import { TrustedPersonNotFoundError } from './domain/errors/trusted-person-not-found.error';
import { TrustedPersonRevokedError } from './domain/errors/trusted-person-revoked.error';
import {
  TrustedPersonPatch,
  TrustedPersonRepository,
} from './infrastructure/persistence/trusted-person.repository';

export interface AddTrustedPersonInput {
  fullName: string;
  phone: string;
  iin: string | null;
  relation: string;
  photoUrl: string | null;
  isOneTime: boolean;
}

export type UpdateTrustedPersonInput = Partial<{
  fullName: string;
  phone: string;
  iin: string | null;
  relation: string;
  photoUrl: string | null;
  isOneTime: boolean;
}>;

/**
 * TrustedPersonService — orchestrates parent-side CRUD over the
 * `trusted_people` whitelist (B11). Each public method takes the
 * caller's `parentUserId` and asserts an approved-active guardian link
 * before touching the row, since RLS alone does not authorize against
 * "is this parent allowed to manage trusted people for this child".
 *
 * Authorization model:
 *   - listByChild: caller must have an approved-active (status='approved',
 *     revoked_at IS NULL) guardian link for the child. Any role with an
 *     active link can view the whitelist — secondaries / nannies need to
 *     see who is currently trusted to pick up the child.
 *   - addByParent / update / revoke: caller must currently be an
 *     approved-active guardian on the same child AND hold the locked
 *     `trusted_people_manage` permission (per docs/endpoints.md §4.13
 *     defaults: primary=true, secondary=false, nanny=false). T7-5 HIGH#3:
 *     previously any approved guardian could mutate the whitelist,
 *     contradicting the BP / endpoints SoT that scopes trusted-people
 *     CRUD to primary by default.
 *   - T7 fix M5: previously a caller was also allowed to manage the row
 *     if their userId matched the historical `added_by_user_id` column,
 *     even after their guardian link had been revoked. That let an
 *     ex-guardian (e.g. revoked parent post-divorce) keep mutating /
 *     revoking trusted_people they had once added. Authorization is now
 *     strictly tied to a current guardian-link with the manage permission,
 *     which is the right invariant — the child's guardian-of-record is
 *     who can curate the whitelist, not whoever happened to add a row
 *     historically.
 */
@Injectable()
export class TrustedPersonService {
  constructor(
    private readonly trustedPeople: TrustedPersonRepository,
    private readonly childGuardians: ChildGuardianRepository,
    private readonly childRepo: ChildRepository,
    @Inject(ClockPort) private readonly clock: ClockPort,
  ) {}

  async listByChild(
    kindergartenId: string,
    childId: string,
    parentUserId: string,
  ): Promise<TrustedPerson[]> {
    await this.assertChildExists(kindergartenId, childId);
    await this.assertParentGuardianLink(kindergartenId, childId, parentUserId);
    return this.trustedPeople.listByChild(kindergartenId, childId);
  }

  async addByParent(
    kindergartenId: string,
    childId: string,
    parentUserId: string,
    input: AddTrustedPersonInput,
  ): Promise<TrustedPerson> {
    await this.assertChildExists(kindergartenId, childId);
    await this.assertCanManageTrustedPeople(
      kindergartenId,
      childId,
      parentUserId,
    );

    return this.trustedPeople.create({
      kindergartenId,
      childId,
      addedByUserId: parentUserId,
      fullName: input.fullName,
      phone: input.phone,
      iin: input.iin,
      relation: input.relation,
      photoUrl: input.photoUrl,
      isOneTime: input.isOneTime,
    });
  }

  async update(
    kindergartenId: string,
    trustedPersonId: string,
    parentUserId: string,
    patch: UpdateTrustedPersonInput,
  ): Promise<TrustedPerson> {
    const tp = await this.trustedPeople.findById(trustedPersonId);
    if (!tp || tp.kindergartenId !== kindergartenId) {
      throw new TrustedPersonNotFoundError(trustedPersonId);
    }
    await this.assertCanManageTrustedPeople(
      tp.kindergartenId,
      tp.childId,
      parentUserId,
    );
    if (tp.isRevoked() || !tp.isActive) {
      throw new TrustedPersonRevokedError();
    }

    const repoPatch: TrustedPersonPatch = {};
    if (patch.fullName !== undefined) repoPatch.fullName = patch.fullName;
    if (patch.phone !== undefined) repoPatch.phone = patch.phone;
    if (patch.iin !== undefined) repoPatch.iin = patch.iin;
    if (patch.relation !== undefined) repoPatch.relation = patch.relation;
    if (patch.photoUrl !== undefined) repoPatch.photoUrl = patch.photoUrl;
    if (patch.isOneTime !== undefined) repoPatch.isOneTime = patch.isOneTime;

    const updated = await this.trustedPeople.update(trustedPersonId, repoPatch);
    if (!updated) {
      throw new TrustedPersonNotFoundError(trustedPersonId);
    }
    return updated;
  }

  async revoke(
    kindergartenId: string,
    trustedPersonId: string,
    parentUserId: string,
  ): Promise<TrustedPerson> {
    const tp = await this.trustedPeople.findById(trustedPersonId);
    if (!tp || tp.kindergartenId !== kindergartenId) {
      throw new TrustedPersonNotFoundError(trustedPersonId);
    }
    await this.assertCanManageTrustedPeople(
      tp.kindergartenId,
      tp.childId,
      parentUserId,
    );

    // Domain guard surfaces "already revoked" / "not active" as TrustedPersonRevokedError
    // (410 Gone). The relational repo's markRevoked is idempotent at the SQL
    // layer (`WHERE revoked_at IS NULL`), so we let the entity invariant fail
    // first to give the API a deterministic 410 response.
    const now = this.clock.now();
    const revoked = tp.revoke(now);
    await this.trustedPeople.markRevoked(tp.id, now);
    return revoked;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private async assertChildExists(
    kindergartenId: string,
    childId: string,
  ): Promise<void> {
    const child = await this.childRepo.findById(kindergartenId, childId);
    if (!child) {
      throw new ChildNotFoundError(childId);
    }
  }

  /**
   * Throws ForbiddenActionError when the caller does not have an
   * approved + non-revoked guardian link for this (kg, child). Used by
   * read-only endpoints (`listByChild`) where any approved guardian role
   * is allowed to inspect the whitelist.
   */
  private async assertParentGuardianLink(
    kindergartenId: string,
    childId: string,
    parentUserId: string,
  ): Promise<ChildGuardian> {
    const link = await this.childGuardians.findActiveByChildAndUser(
      kindergartenId,
      childId,
      parentUserId,
    );
    if (!link) {
      throw new ForbiddenActionError(
        'parent_not_a_guardian',
        'You are not a guardian for this child',
      );
    }
    const state = link.toState();
    if (state.status !== 'approved' || state.revokedAt !== null) {
      throw new ForbiddenActionError(
        'parent_guardian_not_approved',
        'Your guardian link is not approved',
      );
    }
    return link;
  }

  /**
   * T7-5 HIGH#3 — caller is allowed to mutate the whitelist (add /
   * update / revoke) only when their current guardian link grants the
   * locked `trusted_people_manage` permission. Per
   * docs/endpoints.md §4.13 defaults this is primary-only; secondaries
   * and nannies surface `trusted_people_manage_required` (403). The
   * permission is locked, so it cannot be hand-toggled to an unexpected
   * role via PATCH .../permissions — the role's default is the source
   * of truth.
   */
  private async assertCanManageTrustedPeople(
    kindergartenId: string,
    childId: string,
    parentUserId: string,
  ): Promise<void> {
    const link = await this.assertParentGuardianLink(
      kindergartenId,
      childId,
      parentUserId,
    );
    const effective = link.permissions.effective(link.role);
    if (effective.trusted_people_manage !== true) {
      throw new ForbiddenActionError(
        'trusted_people_manage_required',
        'Trusted-people management requires the trusted_people_manage permission (primary guardian)',
      );
    }
  }
}
