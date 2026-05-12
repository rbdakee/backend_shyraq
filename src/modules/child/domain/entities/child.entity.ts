import { ChildId } from '@/shared-kernel/domain/value-objects/child-id.vo';
import { ChildStatus } from '@/shared-kernel/domain/value-objects/child-status.vo';
import { Iin } from '@/shared-kernel/domain/value-objects/iin.vo';
import { KindergartenId } from '@/shared-kernel/domain/value-objects/kindergarten-id.vo';
import { ArchiveReasonRequiredError } from '../errors/archive-reason-required.error';
import { ChildAlreadyArchivedError } from '../errors/child-already-archived.error';
import { ChildNotArchivedError } from '../errors/child-not-archived.error';
import { GroupTransferToSelfError } from '../errors/group-transfer-to-self.error';
import { InvalidChildProfileError } from '../errors/invalid-child-profile.error';
import { InvalidChildStatusTransitionError } from '../errors/invalid-child-status-transition.error';

const ARCHIVE_REASON_MAX_LENGTH = 500;

export type Gender = 'male' | 'female';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Plain TS view of a `children` row. Lives in domain because it's the contract
 * the application/infrastructure layers use to rehydrate a Child without
 * leaking TypeORM types upward.
 */
export interface ChildState {
  id: string;
  kindergartenId: string;
  iin: string | null;
  fullName: string;
  dateOfBirth: Date;
  // DB stores char(1): 'm' | 'f' | null. Domain works with the wider literal.
  gender: 'm' | 'f' | null;
  photoUrl: string | null;
  status: 'card_created' | 'active' | 'archived';
  currentGroupId: string | null;
  enrollmentDate: Date | null;
  archivedAt: Date | null;
  archiveReason: string | null;
  medicalNotes: string | null;
  allergyNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateChildInput {
  id: ChildId;
  kindergartenId: KindergartenId;
  fullName: string;
  iin?: Iin;
  dateOfBirth: Date;
  gender?: Gender;
  photoUrl?: string;
  currentGroupId?: string;
  medicalNotes?: string;
  allergyNotes?: string;
  now: Date;
}

export interface UpdateChildProfilePatch {
  fullName?: string;
  iin?: Iin | null;
  dateOfBirth?: Date;
  gender?: Gender | null;
  photoUrl?: string | null;
  medicalNotes?: string | null;
  allergyNotes?: string | null;
}

function validateFullName(name: string): void {
  if (name.trim().length === 0) {
    throw new InvalidChildProfileError('full_name');
  }
}

function validateDateOfBirth(dob: Date, now: Date): void {
  if (dob.getTime() > now.getTime()) {
    throw new InvalidChildProfileError('date_of_birth');
  }
}

function validateGroupId(groupId: string | undefined | null): void {
  if (groupId === undefined || groupId === null) return;
  if (!UUID_RE.test(groupId)) {
    throw new InvalidChildProfileError('current_group_id');
  }
}

function genderToDb(g: Gender | undefined | null): 'm' | 'f' | null {
  if (g === undefined || g === null) return null;
  return g === 'male' ? 'm' : 'f';
}

function genderFromDb(g: 'm' | 'f' | null): Gender | undefined {
  if (g === null) return undefined;
  return g === 'm' ? 'male' : 'female';
}

/**
 * Child rich aggregate. POJO — no TypeORM/Nest imports. Methods mutate state
 * in place, validate invariants, and throw domain errors for invalid
 * transitions. Persistence happens through the repository port; the entity
 * does not know how it is stored.
 *
 * Domain "events" (in spirit, not as a typed event bus): assignedToGroup,
 * transferredToGroup, archived, restored — encoded as method names so future
 * notification wiring can subscribe to them.
 */
export class Child {
  id: ChildId;
  kindergartenId: KindergartenId;
  iin: Iin | undefined;
  fullName: string;
  dateOfBirth: Date;
  gender: Gender | undefined;
  photoUrl: string | undefined;
  status: ChildStatus;
  currentGroupId: string | undefined;
  enrollmentDate: Date | undefined;
  archivedAt: Date | undefined;
  archiveReason: string | undefined;
  medicalNotes: string | undefined;
  allergyNotes: string | undefined;
  createdAt: Date;
  updatedAt: Date;

  private constructor(props: {
    id: ChildId;
    kindergartenId: KindergartenId;
    iin: Iin | undefined;
    fullName: string;
    dateOfBirth: Date;
    gender: Gender | undefined;
    photoUrl: string | undefined;
    status: ChildStatus;
    currentGroupId: string | undefined;
    enrollmentDate: Date | undefined;
    archivedAt: Date | undefined;
    archiveReason: string | undefined;
    medicalNotes: string | undefined;
    allergyNotes: string | undefined;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = props.id;
    this.kindergartenId = props.kindergartenId;
    this.iin = props.iin;
    this.fullName = props.fullName;
    this.dateOfBirth = props.dateOfBirth;
    this.gender = props.gender;
    this.photoUrl = props.photoUrl;
    this.status = props.status;
    this.currentGroupId = props.currentGroupId;
    this.enrollmentDate = props.enrollmentDate;
    this.archivedAt = props.archivedAt;
    this.archiveReason = props.archiveReason;
    this.medicalNotes = props.medicalNotes;
    this.allergyNotes = props.allergyNotes;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  static createNew(input: CreateChildInput): Child {
    validateFullName(input.fullName);
    validateDateOfBirth(input.dateOfBirth, input.now);
    validateGroupId(input.currentGroupId);

    return new Child({
      id: input.id,
      kindergartenId: input.kindergartenId,
      iin: input.iin,
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth,
      gender: input.gender,
      photoUrl: input.photoUrl,
      status: ChildStatus.CARD_CREATED,
      currentGroupId: input.currentGroupId,
      enrollmentDate: undefined,
      archivedAt: undefined,
      archiveReason: undefined,
      medicalNotes: input.medicalNotes,
      allergyNotes: input.allergyNotes,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static hydrate(state: ChildState): Child {
    return new Child({
      id: ChildId.parse(state.id),
      kindergartenId: KindergartenId.parse(state.kindergartenId),
      iin: state.iin === null ? undefined : Iin.parse(state.iin),
      fullName: state.fullName,
      dateOfBirth: state.dateOfBirth,
      gender: genderFromDb(state.gender),
      photoUrl: state.photoUrl ?? undefined,
      status: ChildStatus.fromString(state.status),
      currentGroupId: state.currentGroupId ?? undefined,
      enrollmentDate: state.enrollmentDate ?? undefined,
      archivedAt: state.archivedAt ?? undefined,
      archiveReason: state.archiveReason ?? undefined,
      medicalNotes: state.medicalNotes ?? undefined,
      allergyNotes: state.allergyNotes ?? undefined,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }

  updateProfile(patch: UpdateChildProfilePatch, now: Date): void {
    if (patch.fullName !== undefined) {
      validateFullName(patch.fullName);
      this.fullName = patch.fullName;
    }
    if (patch.dateOfBirth !== undefined) {
      validateDateOfBirth(patch.dateOfBirth, now);
      this.dateOfBirth = patch.dateOfBirth;
    }
    if (patch.iin !== undefined) {
      this.iin = patch.iin === null ? undefined : patch.iin;
    }
    if (patch.gender !== undefined) {
      this.gender = patch.gender === null ? undefined : patch.gender;
    }
    if (patch.photoUrl !== undefined) {
      this.photoUrl = patch.photoUrl === null ? undefined : patch.photoUrl;
    }
    if (patch.medicalNotes !== undefined) {
      this.medicalNotes =
        patch.medicalNotes === null ? undefined : patch.medicalNotes;
    }
    if (patch.allergyNotes !== undefined) {
      this.allergyNotes =
        patch.allergyNotes === null ? undefined : patch.allergyNotes;
    }
    this.updatedAt = now;
  }

  /**
   * Photo update (or clear). Distinct from `updateProfile` so the corresponding
   * REST endpoint can carry only the photo URL.
   */
  updatePhoto(photoUrl: string | null, now: Date): void {
    this.photoUrl = photoUrl === null ? undefined : photoUrl;
    this.updatedAt = now;
  }

  /**
   * Mutate `currentGroupId` from one group to another. The use-case is expected
   * to record a `child_group_history` row using the returned (from, to) pair.
   * Throws if the target group equals the current group.
   */
  transferToGroup(
    toGroupId: string,
    now: Date,
  ): { fromGroupId: string | null; toGroupId: string } {
    validateGroupId(toGroupId);
    if (
      this.currentGroupId !== undefined &&
      this.currentGroupId === toGroupId
    ) {
      throw new GroupTransferToSelfError();
    }
    const fromGroupId = this.currentGroupId ?? null;
    this.currentGroupId = toGroupId;
    this.updatedAt = now;
    return { fromGroupId, toGroupId };
  }

  /**
   * Initial group assignment for a child that does not yet have one.
   * Idempotent: if `currentGroupId` already equals the target, simply touches
   * `updatedAt`.
   */
  assignToGroup(groupId: string, now: Date): void {
    validateGroupId(groupId);
    this.currentGroupId = groupId;
    this.updatedAt = now;
  }

  /** Drop the child's current group attachment. */
  unassignFromGroup(now: Date): void {
    this.currentGroupId = undefined;
    this.updatedAt = now;
  }

  /** card_created → active. Used by the enrollment flow in later phases. */
  activate(now: Date): void {
    if (!this.status.equals(ChildStatus.CARD_CREATED)) {
      throw new InvalidChildStatusTransitionError(this.status.value, 'active');
    }
    this.status = ChildStatus.ACTIVE;
    this.enrollmentDate = now;
    this.updatedAt = now;
  }

  /**
   * Strict `active` → `archived` state transition. Throws:
   *   - `ChildAlreadyArchivedError` (409) if the child is already archived.
   *   - `InvalidChildStatusTransitionError` (409) if the child is in any
   *     other non-`active` status (e.g. `card_created` — must be activated
   *     first via `Child.activate()`).
   *   - `ArchiveReasonRequiredError` (422) if `reason` is empty / whitespace-
   *     only / longer than 500 chars after trim.
   *
   * `archivedByStaffId` records the actor for downstream audit (e.g. a
   * `child_status_history` row written by the application service). It is
   * not persisted on the `children` row itself — the `children` schema
   * stores only `archived_at` and `archive_reason`; per-actor audit lives in
   * a separate history table managed by the service layer.
   */
  archive(now: Date, reason: string, archivedByStaffId: string): void {
    void archivedByStaffId;
    if (this.status.equals(ChildStatus.ARCHIVED)) {
      throw new ChildAlreadyArchivedError(this.id);
    }
    if (!this.status.equals(ChildStatus.ACTIVE)) {
      throw new InvalidChildStatusTransitionError(
        this.status.value,
        ChildStatus.ARCHIVED.value,
      );
    }
    const trimmed = reason?.trim() ?? '';
    if (trimmed.length === 0 || trimmed.length > ARCHIVE_REASON_MAX_LENGTH) {
      throw new ArchiveReasonRequiredError(this.id);
    }
    this.status = ChildStatus.ARCHIVED;
    this.archivedAt = now;
    this.archiveReason = trimmed;
    this.updatedAt = now;
  }

  /**
   * Strict `archived` → `active` state transition. Throws
   * `ChildNotArchivedError` (409) if the child is not currently archived.
   * Clears `archivedAt` / `archiveReason` so the row is indistinguishable
   * (in steady-state columns) from a never-archived active child; the
   * status-change record lives in `child_status_history` written by the
   * service layer with `reactivatedByStaffId` as actor.
   */
  reactivate(now: Date, reactivatedByStaffId: string): void {
    void reactivatedByStaffId;
    if (!this.status.equals(ChildStatus.ARCHIVED)) {
      throw new ChildNotArchivedError(this.id);
    }
    this.status = ChildStatus.ACTIVE;
    this.archivedAt = undefined;
    this.archiveReason = undefined;
    this.updatedAt = now;
  }

  toState(): ChildState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      iin: this.iin === undefined ? null : this.iin.toString(),
      fullName: this.fullName,
      dateOfBirth: this.dateOfBirth,
      gender: genderToDb(this.gender),
      photoUrl: this.photoUrl ?? null,
      status: this.status.value,
      currentGroupId: this.currentGroupId ?? null,
      enrollmentDate: this.enrollmentDate ?? null,
      archivedAt: this.archivedAt ?? null,
      archiveReason: this.archiveReason ?? null,
      medicalNotes: this.medicalNotes ?? null,
      allergyNotes: this.allergyNotes ?? null,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
