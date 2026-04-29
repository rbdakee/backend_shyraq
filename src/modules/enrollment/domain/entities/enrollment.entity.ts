import { EnrollmentAlreadyConvertedError } from '../errors/enrollment-already-converted.error';
import { EnrollmentLockedError } from '../errors/enrollment-locked.error';
import { EnrollmentMissingRequiredFieldsError } from '../errors/enrollment-missing-required-fields.error';
import { InvalidEnrollmentStatusTransitionError } from '../errors/invalid-enrollment-status-transition.error';
import { EnrollmentStatusLogEntryDraft } from '../types/enrollment-status-log-entry';
import {
  EnrollmentStatus,
  EnrollmentStatusValue,
} from '../value-objects/enrollment-status.vo';

/**
 * Plain TS view of an `enrollments` row. Lives in domain because it's the
 * contract the application/infrastructure layers use to rehydrate an
 * Enrollment without leaking TypeORM types upward. Mirrors the column shape
 * declared by the EnrollmentTables migration.
 */
export interface EnrollmentState {
  id: string;
  kindergartenId: string;
  childId: string | null;
  contactName: string;
  contactPhone: string;
  childName: string | null;
  childDob: Date | null;
  childIin: string | null;
  status: EnrollmentStatusValue;
  source: string | null;
  notes: string | null;
  assignedTo: string | null;
  statusChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateEnrollmentInput {
  kindergartenId: string;
  contactName: string;
  contactPhone: string;
  childName?: string;
  childDob?: Date;
  childIin?: string;
  source?: string;
  notes?: string;
  assignedTo?: string;
}

export interface UpdateEnrollmentPatch {
  contactName?: string;
  contactPhone?: string;
  childName?: string | null;
  childDob?: Date | null;
  childIin?: string | null;
  source?: string | null;
  notes?: string | null;
  assignedTo?: string | null;
}

export interface Clock {
  now(): Date;
}

const LOCKED_STATUSES: ReadonlySet<EnrollmentStatusValue> =
  new Set<EnrollmentStatusValue>(['card_created', 'cancelled', 'archive']);

function isBlankString(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim().length === 0;
}

/**
 * Enrollment rich aggregate (lead/inquiry record). POJO — no TypeORM/Nest
 * imports. The child-conversion side-effect (creating a `children` row) is
 * NOT here: `transitionTo(card_created, …)` only flips the status and
 * returns the audit-log draft; the service layer wires Child.createNew +
 * `assignChild` inside one transaction.
 *
 * Domain "events" (encoded as method names): created, transitioned, assigned
 * (to staff), updated, childAssigned (lead → child link).
 */
export class Enrollment {
  id: string;
  kindergartenId: string;
  childId: string | null;
  contactName: string;
  contactPhone: string;
  childName: string | null;
  childDob: Date | null;
  childIin: string | null;
  status: EnrollmentStatus;
  source: string | null;
  notes: string | null;
  assignedTo: string | null;
  statusChangedAt: Date;
  createdAt: Date;
  updatedAt: Date;

  private constructor(props: {
    id: string;
    kindergartenId: string;
    childId: string | null;
    contactName: string;
    contactPhone: string;
    childName: string | null;
    childDob: Date | null;
    childIin: string | null;
    status: EnrollmentStatus;
    source: string | null;
    notes: string | null;
    assignedTo: string | null;
    statusChangedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  }) {
    this.id = props.id;
    this.kindergartenId = props.kindergartenId;
    this.childId = props.childId;
    this.contactName = props.contactName;
    this.contactPhone = props.contactPhone;
    this.childName = props.childName;
    this.childDob = props.childDob;
    this.childIin = props.childIin;
    this.status = props.status;
    this.source = props.source;
    this.notes = props.notes;
    this.assignedTo = props.assignedTo;
    this.statusChangedAt = props.statusChangedAt;
    this.createdAt = props.createdAt;
    this.updatedAt = props.updatedAt;
  }

  /**
   * Factory for a fresh `new`-status lead. ID is injected (mirrors the
   * Child aggregate convention; in HTTP flows the service supplies a UUID,
   * in tests the spec passes a stable fixture).
   */
  static createNew(
    input: CreateEnrollmentInput,
    clock: Clock,
    idGenerator: () => string,
  ): Enrollment {
    const now = clock.now();
    return new Enrollment({
      id: idGenerator(),
      kindergartenId: input.kindergartenId,
      childId: null,
      contactName: input.contactName,
      contactPhone: input.contactPhone,
      childName: input.childName ?? null,
      childDob: input.childDob ?? null,
      childIin: input.childIin ?? null,
      status: EnrollmentStatus.NEW,
      source: input.source ?? null,
      notes: input.notes ?? null,
      assignedTo: input.assignedTo ?? null,
      statusChangedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  static hydrate(state: EnrollmentState): Enrollment {
    return new Enrollment({
      id: state.id,
      kindergartenId: state.kindergartenId,
      childId: state.childId,
      contactName: state.contactName,
      contactPhone: state.contactPhone,
      childName: state.childName,
      childDob: state.childDob,
      childIin: state.childIin,
      status: EnrollmentStatus.from(state.status),
      source: state.source,
      notes: state.notes,
      assignedTo: state.assignedTo,
      statusChangedAt: state.statusChangedAt,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }

  /**
   * Status transition with audit-log draft. Validates the edge is allowed,
   * enforces card_created prerequisites, and updates statusChangedAt +
   * updatedAt. Returns the log draft (id-less) for the repository to persist
   * inside the same transaction.
   *
   * IMPORTANT: this method does NOT create the `children` row or set
   * `childId`. That's a service-layer side-effect — see `assignChild` below.
   */
  transitionTo(
    next: EnrollmentStatus,
    by: string,
    comment: string | null,
    clock: Clock,
  ): { logEntry: EnrollmentStatusLogEntryDraft } {
    if (!this.status.canTransitionTo(next)) {
      throw new InvalidEnrollmentStatusTransitionError(
        this.status.value,
        next.value,
      );
    }

    if (next.equals(EnrollmentStatus.CARD_CREATED)) {
      if (this.childId !== null) {
        throw new EnrollmentAlreadyConvertedError(this.id, this.childId);
      }
      const missing: string[] = [];
      if (isBlankString(this.childName)) missing.push('childName');
      if (this.childDob === null) missing.push('childDob');
      if (isBlankString(this.contactName)) missing.push('contactName');
      if (isBlankString(this.contactPhone)) missing.push('contactPhone');
      if (missing.length > 0) {
        throw new EnrollmentMissingRequiredFieldsError(missing);
      }
    }

    const fromStatus = this.status.value;
    const now = clock.now();
    this.status = next;
    this.statusChangedAt = now;
    this.updatedAt = now;

    return {
      logEntry: {
        enrollmentId: this.id,
        kindergartenId: this.kindergartenId,
        fromStatus,
        toStatus: next.value,
        changedBy: by,
        comment,
        createdAt: now,
      },
    };
  }

  /**
   * Service-layer helper — links the freshly-created child card back to this
   * enrollment after `transitionTo(card_created)`. No status check: contract
   * is "called only inside the same transaction as the card_created
   * transition". Touches updatedAt for change-tracking.
   */
  assignChild(childId: string, clock: Clock): void {
    this.childId = childId;
    this.updatedAt = clock.now();
  }

  /**
   * Reassign the lead to a different staff member. Disallowed on terminal
   * (archive) status. Distinct from `update` so the corresponding REST
   * endpoint can carry only the staff id.
   */
  assignTo(staffMemberId: string, clock: Clock): void {
    if (this.status.isTerminal()) {
      throw new EnrollmentLockedError(this.status.value);
    }
    this.assignedTo = staffMemberId;
    this.updatedAt = clock.now();
  }

  /**
   * Patch lead-side fields. Locked once the lead has been converted
   * (`card_created`), explicitly cancelled, or archived — those statuses
   * are read-only audit records, not editable rows.
   *
   * Plan §4.4: `null` is the explicit "clear optional field" sentinel for
   * nullable columns; required strings (contactName/contactPhone) cannot be
   * nulled by patch — only replaced.
   */
  update(patch: UpdateEnrollmentPatch, clock: Clock): void {
    if (LOCKED_STATUSES.has(this.status.value)) {
      throw new EnrollmentLockedError(this.status.value);
    }
    if (patch.contactName !== undefined) {
      this.contactName = patch.contactName;
    }
    if (patch.contactPhone !== undefined) {
      this.contactPhone = patch.contactPhone;
    }
    if (patch.childName !== undefined) {
      this.childName = patch.childName;
    }
    if (patch.childDob !== undefined) {
      this.childDob = patch.childDob;
    }
    if (patch.childIin !== undefined) {
      this.childIin = patch.childIin;
    }
    if (patch.source !== undefined) {
      this.source = patch.source;
    }
    if (patch.notes !== undefined) {
      this.notes = patch.notes;
    }
    if (patch.assignedTo !== undefined) {
      this.assignedTo = patch.assignedTo;
    }
    this.updatedAt = clock.now();
  }

  toState(): EnrollmentState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this.childId,
      contactName: this.contactName,
      contactPhone: this.contactPhone,
      childName: this.childName,
      childDob: this.childDob,
      childIin: this.childIin,
      status: this.status.value,
      source: this.source,
      notes: this.notes,
      assignedTo: this.assignedTo,
      statusChangedAt: this.statusChangedAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}
