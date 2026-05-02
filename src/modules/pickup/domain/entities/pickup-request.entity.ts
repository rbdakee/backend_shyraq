import { PickupRequestAlreadyValidatedError } from '../errors/pickup-request-already-validated.error';
import { PickupRequestExpiredError } from '../errors/pickup-request-expired.error';
import { PickupRequestStatusInvalidError } from '../errors/pickup-request-status-invalid.error';

export type PickupRequestStatus =
  | 'otp_sent'
  | 'validated'
  | 'expired'
  | 'cancelled';

/**
 * Plain TS view of a `pickup_requests` row. Lives in domain so the
 * application/infrastructure layers can rehydrate without leaking TypeORM.
 */
export interface PickupRequestState {
  id: string;
  kindergartenId: string;
  childId: string;
  requestedByUserId: string;
  trustedPersonId: string | null;
  trustedPersonPhone: string;
  trustedPersonName: string;
  trustedPersonIin: string | null;
  otpRef: string | null;
  status: PickupRequestStatus;
  validatedBy: string | null;
  validatedAt: Date | null;
  attendanceEventId: string | null;
  parentRequestId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreatePickupRequestInput {
  id: string;
  kindergartenId: string;
  childId: string;
  requestedByUserId: string;
  trustedPersonId: string | null;
  trustedPersonPhone: string;
  trustedPersonName: string;
  trustedPersonIin: string | null;
  expiresAt: Date;
  parentRequestId: string | null;
  createdAt: Date;
}

/**
 * PickupRequest aggregate (B11). POJO — no TypeORM/Nest imports. Immutable
 * state-machine: all transitions return new instances.
 *
 * State machine:
 *
 *   otp_sent ──validate(staff,event,now)──► validated   (terminal)
 *      │
 *      ├──expire(now)──► expired                          (terminal)
 *      │
 *      └──cancel(now)──► cancelled                        (terminal)
 *
 * Terminal states cannot transition further — any attempt throws a domain
 * error that the service layer maps to HTTP via `DomainErrorFilter`.
 *
 * `attachOtpRef` is a non-state-changing update used by the issuance flow
 * to stamp the SMS provider's transaction id post-INSERT. It is only
 * valid in `otp_sent`.
 */
export class PickupRequest {
  private constructor(
    readonly id: string,
    readonly kindergartenId: string,
    readonly childId: string,
    readonly requestedByUserId: string,
    readonly trustedPersonId: string | null,
    readonly trustedPersonPhone: string,
    readonly trustedPersonName: string,
    readonly trustedPersonIin: string | null,
    readonly otpRef: string | null,
    readonly status: PickupRequestStatus,
    readonly validatedBy: string | null,
    readonly validatedAt: Date | null,
    readonly attendanceEventId: string | null,
    readonly parentRequestId: string | null,
    readonly expiresAt: Date,
    readonly createdAt: Date,
  ) {}

  static create(input: CreatePickupRequestInput): PickupRequest {
    if (input.expiresAt.getTime() <= input.createdAt.getTime()) {
      throw new Error(
        'PickupRequest.create: expiresAt must be after createdAt',
      );
    }
    return new PickupRequest(
      input.id,
      input.kindergartenId,
      input.childId,
      input.requestedByUserId,
      input.trustedPersonId,
      input.trustedPersonPhone,
      input.trustedPersonName,
      input.trustedPersonIin,
      null,
      'otp_sent',
      null,
      null,
      null,
      input.parentRequestId,
      input.expiresAt,
      input.createdAt,
    );
  }

  static fromState(state: PickupRequestState): PickupRequest {
    return new PickupRequest(
      state.id,
      state.kindergartenId,
      state.childId,
      state.requestedByUserId,
      state.trustedPersonId,
      state.trustedPersonPhone,
      state.trustedPersonName,
      state.trustedPersonIin,
      state.otpRef,
      state.status,
      state.validatedBy,
      state.validatedAt,
      state.attendanceEventId,
      state.parentRequestId,
      state.expiresAt,
      state.createdAt,
    );
  }

  /** True iff `now >= expiresAt`. The clock is supplied by the service. */
  isExpired(now: Date): boolean {
    return now.getTime() >= this.expiresAt.getTime();
  }

  /**
   * Service-layer guard — true when the request can still be acted upon
   * (i.e. it sits in `otp_sent` and the deadline has not passed).
   */
  isPending(now: Date): boolean {
    return this.status === 'otp_sent' && !this.isExpired(now);
  }

  /**
   * Validates the request — moves to terminal `validated`. Throws domain
   * errors for terminal-state and expired guards so the service surfaces
   * 4xx responses (`DomainErrorFilter` maps `code` → HTTP).
   */
  validate(
    staffMemberId: string,
    attendanceEventId: string,
    now: Date,
  ): PickupRequest {
    if (this.status === 'validated') {
      throw new PickupRequestAlreadyValidatedError();
    }
    if (this.status !== 'otp_sent') {
      throw new PickupRequestStatusInvalidError(
        this.status,
        'otp_sent',
        'validate',
      );
    }
    if (this.isExpired(now)) {
      throw new PickupRequestExpiredError();
    }
    return new PickupRequest(
      this.id,
      this.kindergartenId,
      this.childId,
      this.requestedByUserId,
      this.trustedPersonId,
      this.trustedPersonPhone,
      this.trustedPersonName,
      this.trustedPersonIin,
      this.otpRef,
      'validated',
      staffMemberId,
      now,
      attendanceEventId,
      this.parentRequestId,
      this.expiresAt,
      this.createdAt,
    );
  }

  /** Moves to terminal `expired`. Throws on terminal-state. */
  expire(now: Date): PickupRequest {
    if (this.status !== 'otp_sent') {
      throw new PickupRequestStatusInvalidError(
        this.status,
        'otp_sent',
        'expire',
      );
    }
    // `now` is informational — the persistence shape doesn't carry an
    // `expired_at` column today (status alone is the signal). Touching it
    // keeps the signature symmetric with validate/cancel.
    void now;
    return new PickupRequest(
      this.id,
      this.kindergartenId,
      this.childId,
      this.requestedByUserId,
      this.trustedPersonId,
      this.trustedPersonPhone,
      this.trustedPersonName,
      this.trustedPersonIin,
      this.otpRef,
      'expired',
      this.validatedBy,
      this.validatedAt,
      this.attendanceEventId,
      this.parentRequestId,
      this.expiresAt,
      this.createdAt,
    );
  }

  /** Moves to terminal `cancelled`. Throws on terminal-state. */
  cancel(now: Date): PickupRequest {
    if (this.status !== 'otp_sent') {
      throw new PickupRequestStatusInvalidError(
        this.status,
        'otp_sent',
        'cancel',
      );
    }
    void now;
    return new PickupRequest(
      this.id,
      this.kindergartenId,
      this.childId,
      this.requestedByUserId,
      this.trustedPersonId,
      this.trustedPersonPhone,
      this.trustedPersonName,
      this.trustedPersonIin,
      this.otpRef,
      'cancelled',
      this.validatedBy,
      this.validatedAt,
      this.attendanceEventId,
      this.parentRequestId,
      this.expiresAt,
      this.createdAt,
    );
  }

  /**
   * Returns a new PickupRequest with the SMS-provider transaction id
   * stamped. Service uses this immediately after `SmsPort.send` returns —
   * persistence-side flow is INSERT (otpRef=null) → SmsPort.send → UPDATE
   * to attach the txnId.
   *
   * Allowed only while the request is still `otp_sent`. Throws otherwise
   * because attaching to a terminal-state row would lose the audit trail.
   */
  attachOtpRef(otpRef: string): PickupRequest {
    if (this.status !== 'otp_sent') {
      throw new PickupRequestStatusInvalidError(
        this.status,
        'otp_sent',
        'attachOtpRef',
      );
    }
    return new PickupRequest(
      this.id,
      this.kindergartenId,
      this.childId,
      this.requestedByUserId,
      this.trustedPersonId,
      this.trustedPersonPhone,
      this.trustedPersonName,
      this.trustedPersonIin,
      otpRef,
      this.status,
      this.validatedBy,
      this.validatedAt,
      this.attendanceEventId,
      this.parentRequestId,
      this.expiresAt,
      this.createdAt,
    );
  }

  toState(): PickupRequestState {
    return {
      id: this.id,
      kindergartenId: this.kindergartenId,
      childId: this.childId,
      requestedByUserId: this.requestedByUserId,
      trustedPersonId: this.trustedPersonId,
      trustedPersonPhone: this.trustedPersonPhone,
      trustedPersonName: this.trustedPersonName,
      trustedPersonIin: this.trustedPersonIin,
      otpRef: this.otpRef,
      status: this.status,
      validatedBy: this.validatedBy,
      validatedAt: this.validatedAt,
      attendanceEventId: this.attendanceEventId,
      parentRequestId: this.parentRequestId,
      expiresAt: this.expiresAt,
      createdAt: this.createdAt,
    };
  }
}
