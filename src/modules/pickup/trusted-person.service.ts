import { Inject, Injectable } from '@nestjs/common';
import { ChildNotFoundError } from '@/modules/child/domain/errors/child-not-found.error';
import { ChildGuardianRepository } from '@/modules/child/infrastructure/persistence/child-guardian.repository';
import { ChildRepository } from '@/modules/child/infrastructure/persistence/child.repository';
import { ClockPort } from '@/shared-kernel/application/ports/clock.port';
import { ForbiddenActionError } from '@/shared-kernel/domain/errors';
import { TrustedPerson } from './domain/entities/trusted-person.entity';
import { TrustedPersonNotFoundError } from './domain/errors/trusted-person-not-found.error';
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
 *   - listByChild / addByParent: caller must have an approved-active
 *     (status='approved', revoked_at IS NULL) guardian link for the
 *     child. `can_pickup` is NOT required to manage the whitelist —
 *     a parent without pickup-rights can still curate trusted people
 *     for the primary guardian.
 *   - update / revoke: caller must be the user that originally added
 *     the row OR an approved-active guardian on the same child.
 *     (Primary guardians effectively manage every trusted person under
 *     their child.) `findActiveByChildAndUser` is used for the
 *     existence-of-link check; the actual "is this caller approved"
 *     status check is done in TS to keep the SQL trivial.
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
    await this.assertParentGuardianLink(kindergartenId, childId, parentUserId);

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
    await this.assertCallerCanManage(tp, parentUserId);

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
    await this.assertCallerCanManage(tp, parentUserId);

    // Domain guard surfaces "already revoked" / "not active" as Error —
    // the relational repo's markRevoked is idempotent at the SQL layer
    // (`WHERE revoked_at IS NULL`), so we let the entity invariant fail
    // first to give the API a deterministic 409-style response.
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
   * approved + non-revoked guardian link for this (kg, child).
   */
  private async assertParentGuardianLink(
    kindergartenId: string,
    childId: string,
    parentUserId: string,
  ): Promise<void> {
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
  }

  /**
   * Caller is allowed to manage the trusted_person row when they either
   * added it OR have an approved-active guardian link on the same child.
   */
  private async assertCallerCanManage(
    tp: TrustedPerson,
    parentUserId: string,
  ): Promise<void> {
    if (tp.addedByUserId === parentUserId) {
      return;
    }
    await this.assertParentGuardianLink(
      tp.kindergartenId,
      tp.childId,
      parentUserId,
    );
  }
}
