import { ParentRequest, ParentRequestState } from './parent-request.entity';
import { ParentRequestStatusInvalidError } from '../errors/parent-request-status-invalid.error';

const NOW = new Date('2026-05-06T10:00:00Z');
const LATER = new Date('2026-05-06T11:00:00Z');
const STAFF_ID = 'staff-member-uuid-0001';
const REVIEW_NOTE = 'approved';

function makePending(
  overrides: Partial<ParentRequestState> = {},
): ParentRequest {
  return ParentRequest.fromState({
    id: 'req-uuid-0001',
    kindergartenId: 'kg-uuid-0001',
    childId: 'child-uuid-0001',
    requesterUserId: 'user-uuid-0001',
    requestType: 'day_off',
    status: 'pending',
    dateFrom: null,
    dateTo: null,
    details: {},
    recipientType: 'mentor',
    recipientStaffId: 'staff-uuid-0001',
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    invoiceId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

describe('ParentRequest domain entity', () => {
  // ── isPending / isReviewed truth table ──────────────────────────────────

  it('returns isPending=true when status is pending', () => {
    const req = makePending();
    expect(req.isPending()).toBe(true);
    expect(req.isReviewed()).toBe(false);
  });

  it('returns isReviewed=true when status is accepted', () => {
    const req = makePending({ status: 'accepted' });
    expect(req.isReviewed()).toBe(true);
    expect(req.isPending()).toBe(false);
  });

  it('returns isReviewed=true when status is rejected', () => {
    const req = makePending({ status: 'rejected' });
    expect(req.isReviewed()).toBe(true);
    expect(req.isPending()).toBe(false);
  });

  it('returns isPending=false and isReviewed=false when status is cancelled', () => {
    const req = makePending({ status: 'cancelled' });
    expect(req.isPending()).toBe(false);
    expect(req.isReviewed()).toBe(false);
  });

  // ── accept() ────────────────────────────────────────────────────────────

  it('transitions to accepted from pending with correct fields set', () => {
    const req = makePending();
    req.accept(STAFF_ID, LATER, REVIEW_NOTE);
    const s = req.toState();
    expect(s.status).toBe('accepted');
    expect(s.reviewedBy).toBe(STAFF_ID);
    expect(s.reviewedAt).toBe(LATER);
    expect(s.reviewNote).toBe(REVIEW_NOTE);
    expect(s.updatedAt).toBe(LATER);
  });

  it('accept() sets reviewNote to null when not provided', () => {
    const req = makePending();
    req.accept(STAFF_ID, LATER);
    expect(req.toState().reviewNote).toBeNull();
  });

  it('throws ParentRequestStatusInvalidError when accepting an already-accepted request', () => {
    const req = makePending({ status: 'accepted' });
    expect(() => req.accept(STAFF_ID, LATER)).toThrow(
      ParentRequestStatusInvalidError,
    );
  });

  it('throws ParentRequestStatusInvalidError when accepting a rejected request', () => {
    const req = makePending({ status: 'rejected' });
    expect(() => req.accept(STAFF_ID, LATER)).toThrow(
      ParentRequestStatusInvalidError,
    );
  });

  it('throws ParentRequestStatusInvalidError when accepting a cancelled request', () => {
    const req = makePending({ status: 'cancelled' });
    expect(() => req.accept(STAFF_ID, LATER)).toThrow(
      ParentRequestStatusInvalidError,
    );
  });

  // ── reject() ────────────────────────────────────────────────────────────

  it('transitions to rejected from pending with correct fields set', () => {
    const req = makePending();
    req.reject(STAFF_ID, LATER, 'reason');
    const s = req.toState();
    expect(s.status).toBe('rejected');
    expect(s.reviewedBy).toBe(STAFF_ID);
    expect(s.reviewedAt).toBe(LATER);
    expect(s.reviewNote).toBe('reason');
    expect(s.updatedAt).toBe(LATER);
  });

  it('throws ParentRequestStatusInvalidError when rejecting a non-pending request', () => {
    const req = makePending({ status: 'accepted' });
    expect(() => req.reject(STAFF_ID, LATER)).toThrow(
      ParentRequestStatusInvalidError,
    );
  });

  it('throws ParentRequestStatusInvalidError when rejecting a cancelled request', () => {
    const req = makePending({ status: 'cancelled' });
    expect(() => req.reject(STAFF_ID, LATER)).toThrow(
      ParentRequestStatusInvalidError,
    );
  });

  it('throws ParentRequestStatusInvalidError when rejecting a rejected request', () => {
    const req = makePending({ status: 'rejected' });
    expect(() => req.reject(STAFF_ID, LATER)).toThrow(
      ParentRequestStatusInvalidError,
    );
  });

  // ── cancel() ────────────────────────────────────────────────────────────

  it('transitions to cancelled from pending', () => {
    const req = makePending();
    req.cancel(LATER);
    const s = req.toState();
    expect(s.status).toBe('cancelled');
    expect(s.updatedAt).toBe(LATER);
  });

  it('throws ParentRequestStatusInvalidError when cancelling an accepted request', () => {
    const req = makePending({ status: 'accepted' });
    expect(() => req.cancel(LATER)).toThrow(ParentRequestStatusInvalidError);
  });

  it('throws ParentRequestStatusInvalidError when cancelling a rejected request', () => {
    const req = makePending({ status: 'rejected' });
    expect(() => req.cancel(LATER)).toThrow(ParentRequestStatusInvalidError);
  });

  it('throws ParentRequestStatusInvalidError when cancelling an already-cancelled request', () => {
    const req = makePending({ status: 'cancelled' });
    expect(() => req.cancel(LATER)).toThrow(ParentRequestStatusInvalidError);
  });

  // ── error details ────────────────────────────────────────────────────────

  it('ParentRequestStatusInvalidError carries currentStatus and attemptedAction', () => {
    const req = makePending({ status: 'accepted' });
    try {
      req.accept(STAFF_ID, LATER);
      fail('expected error to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParentRequestStatusInvalidError);
      const e = err as ParentRequestStatusInvalidError;
      expect(e.details.currentStatus).toBe('accepted');
      expect(e.details.attemptedAction).toBe('accepted');
      expect(e.code).toBe('parent_request_status_invalid');
    }
  });

  // ── toState / fromState round-trip ───────────────────────────────────────

  it('round-trips state correctly through fromState and toState', () => {
    const state: ParentRequestState = {
      id: 'req-uuid-0002',
      kindergartenId: 'kg-uuid-0002',
      childId: 'child-uuid-0002',
      requesterUserId: 'user-uuid-0002',
      requestType: 'vacation',
      status: 'pending',
      dateFrom: new Date('2026-06-01'),
      dateTo: new Date('2026-06-07'),
      details: { comment: 'family trip' },
      recipientType: 'admin',
      recipientStaffId: null,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      invoiceId: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const req = ParentRequest.fromState(state);
    expect(req.toState()).toEqual(state);
  });
});
