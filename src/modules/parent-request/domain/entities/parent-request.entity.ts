import { ParentRequestStatusInvalidError } from '../errors/parent-request-status-invalid.error';

export type ParentRequestType =
  | 'trusted_person'
  | 'day_off'
  | 'vacation'
  | 'late_pickup'
  | 'open_request';

export type ParentRequestStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled';

export type ParentRequestRecipientType =
  | 'admin'
  | 'mentor'
  | 'specialist'
  | null;

export interface ParentRequestState {
  id: string;
  kindergartenId: string;
  childId: string;
  requesterUserId: string;
  requestType: ParentRequestType;
  status: ParentRequestStatus;
  dateFrom: Date | null;
  dateTo: Date | null;
  details: Record<string, unknown>;
  recipientType: ParentRequestRecipientType;
  recipientStaffId: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  invoiceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class ParentRequest {
  private constructor(private state: ParentRequestState) {}

  static fromState(s: ParentRequestState): ParentRequest {
    return new ParentRequest({ ...s });
  }

  toState(): ParentRequestState {
    return { ...this.state };
  }

  // --- getters ---

  get id(): string {
    return this.state.id;
  }

  get kindergartenId(): string {
    return this.state.kindergartenId;
  }

  get childId(): string {
    return this.state.childId;
  }

  get requesterUserId(): string {
    return this.state.requesterUserId;
  }

  get requestType(): ParentRequestType {
    return this.state.requestType;
  }

  get status(): ParentRequestStatus {
    return this.state.status;
  }

  get dateFrom(): Date | null {
    return this.state.dateFrom;
  }

  get dateTo(): Date | null {
    return this.state.dateTo;
  }

  get details(): Record<string, unknown> {
    return this.state.details;
  }

  get recipientType(): ParentRequestRecipientType {
    return this.state.recipientType;
  }

  get recipientStaffId(): string | null {
    return this.state.recipientStaffId;
  }

  get reviewedBy(): string | null {
    return this.state.reviewedBy;
  }

  get reviewedAt(): Date | null {
    return this.state.reviewedAt;
  }

  get reviewNote(): string | null {
    return this.state.reviewNote;
  }

  get invoiceId(): string | null {
    return this.state.invoiceId;
  }

  get createdAt(): Date {
    return this.state.createdAt;
  }

  get updatedAt(): Date {
    return this.state.updatedAt;
  }

  // --- predicates ---

  isPending(): boolean {
    return this.state.status === 'pending';
  }

  isReviewed(): boolean {
    return this.state.status === 'accepted' || this.state.status === 'rejected';
  }

  // --- state-machine transitions ---

  accept(staffMemberId: string, now: Date, reviewNote?: string | null): void {
    if (!this.isPending()) {
      throw new ParentRequestStatusInvalidError(this.state.status, 'accepted');
    }
    this.state.status = 'accepted';
    this.state.reviewedBy = staffMemberId;
    this.state.reviewedAt = now;
    this.state.reviewNote = reviewNote ?? null;
    this.state.updatedAt = now;
  }

  reject(staffMemberId: string, now: Date, reviewNote?: string | null): void {
    if (!this.isPending()) {
      throw new ParentRequestStatusInvalidError(this.state.status, 'rejected');
    }
    this.state.status = 'rejected';
    this.state.reviewedBy = staffMemberId;
    this.state.reviewedAt = now;
    this.state.reviewNote = reviewNote ?? null;
    this.state.updatedAt = now;
  }

  cancel(now: Date): void {
    if (!this.isPending()) {
      throw new ParentRequestStatusInvalidError(this.state.status, 'cancelled');
    }
    this.state.status = 'cancelled';
    this.state.updatedAt = now;
  }
}
