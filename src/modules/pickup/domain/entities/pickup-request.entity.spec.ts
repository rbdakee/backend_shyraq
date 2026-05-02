import { PickupRequestAlreadyValidatedError } from '../errors/pickup-request-already-validated.error';
import { PickupRequestExpiredError } from '../errors/pickup-request-expired.error';
import { PickupRequestStatusInvalidError } from '../errors/pickup-request-status-invalid.error';
import { PickupRequest } from './pickup-request.entity';

describe('PickupRequest (domain)', () => {
  const createdAt = new Date('2026-05-01T10:00:00Z');
  const expiresAt = new Date('2026-05-01T10:15:00Z'); // +15min
  const validInput = {
    id: '00000000-0000-4000-8000-000000000001',
    kindergartenId: '11111111-1111-4000-8000-000000000001',
    childId: '22222222-2222-4000-8000-000000000001',
    requestedByUserId: '33333333-3333-4000-8000-000000000001',
    trustedPersonId: '44444444-4444-4000-8000-000000000001' as string | null,
    trustedPersonPhone: '+77011234567',
    trustedPersonName: 'Айгерим Тестова',
    trustedPersonIin: null as string | null,
    expiresAt,
    parentRequestId: null as string | null,
    createdAt,
  };
  const staffMemberId = '55555555-5555-4000-8000-000000000001';
  const attendanceEventId = '66666666-6666-4000-8000-000000000001';

  it('creates with status=otp_sent, no otpRef, no validation fields', () => {
    const r = PickupRequest.create(validInput);
    expect(r.status).toBe('otp_sent');
    expect(r.otpRef).toBeNull();
    expect(r.validatedBy).toBeNull();
    expect(r.validatedAt).toBeNull();
    expect(r.attendanceEventId).toBeNull();
  });

  it('rejects expiresAt equal to createdAt', () => {
    expect(() =>
      PickupRequest.create({ ...validInput, expiresAt: createdAt }),
    ).toThrow(/expiresAt must be after createdAt/);
  });

  it('rejects expiresAt before createdAt', () => {
    expect(() =>
      PickupRequest.create({
        ...validInput,
        expiresAt: new Date(createdAt.getTime() - 1),
      }),
    ).toThrow(/expiresAt must be after createdAt/);
  });

  it('isExpired returns true when now equals expiresAt', () => {
    const r = PickupRequest.create(validInput);
    expect(r.isExpired(expiresAt)).toBe(true);
  });

  it('isExpired returns false when now is before expiresAt', () => {
    const r = PickupRequest.create(validInput);
    expect(r.isExpired(new Date(expiresAt.getTime() - 1))).toBe(false);
  });

  it('isPending returns true while status=otp_sent and not expired', () => {
    const r = PickupRequest.create(validInput);
    const now = new Date(createdAt.getTime() + 60_000);
    expect(r.isPending(now)).toBe(true);
  });

  it('isPending returns false when expired', () => {
    const r = PickupRequest.create(validInput);
    expect(r.isPending(expiresAt)).toBe(false);
  });

  it('validate transitions to validated and stamps staff + event + validatedAt', () => {
    const r = PickupRequest.create(validInput);
    const now = new Date(createdAt.getTime() + 60_000);
    const v = r.validate(staffMemberId, attendanceEventId, now);
    expect(v).not.toBe(r);
    expect(v.status).toBe('validated');
    expect(v.validatedBy).toBe(staffMemberId);
    expect(v.validatedAt).toBe(now);
    expect(v.attendanceEventId).toBe(attendanceEventId);
    expect(r.status).toBe('otp_sent'); // immutability
  });

  it('validate throws PickupRequestAlreadyValidatedError when already validated', () => {
    const v = PickupRequest.create(validInput).validate(
      staffMemberId,
      attendanceEventId,
      new Date(createdAt.getTime() + 60_000),
    );
    expect(() =>
      v.validate(
        staffMemberId,
        attendanceEventId,
        new Date(createdAt.getTime() + 120_000),
      ),
    ).toThrow(PickupRequestAlreadyValidatedError);
  });

  it('validate throws PickupRequestExpiredError when now >= expiresAt', () => {
    const r = PickupRequest.create(validInput);
    expect(() =>
      r.validate(staffMemberId, attendanceEventId, expiresAt),
    ).toThrow(PickupRequestExpiredError);
  });

  it('validate throws PickupRequestStatusInvalidError when status=cancelled', () => {
    const c = PickupRequest.create(validInput).cancel(
      new Date(createdAt.getTime() + 30_000),
    );
    expect(() =>
      c.validate(
        staffMemberId,
        attendanceEventId,
        new Date(createdAt.getTime() + 60_000),
      ),
    ).toThrow(PickupRequestStatusInvalidError);
  });

  it('validate throws PickupRequestStatusInvalidError when status=expired', () => {
    const e = PickupRequest.create(validInput).expire(
      new Date(createdAt.getTime() + 30_000),
    );
    expect(() =>
      e.validate(
        staffMemberId,
        attendanceEventId,
        new Date(createdAt.getTime() + 60_000),
      ),
    ).toThrow(PickupRequestStatusInvalidError);
  });

  it('expire transitions otp_sent → expired', () => {
    const r = PickupRequest.create(validInput);
    const e = r.expire(new Date(createdAt.getTime() + 30_000));
    expect(e).not.toBe(r);
    expect(e.status).toBe('expired');
  });

  it('expire throws when called on a terminal-state row', () => {
    const v = PickupRequest.create(validInput).validate(
      staffMemberId,
      attendanceEventId,
      new Date(createdAt.getTime() + 60_000),
    );
    expect(() => v.expire(new Date(createdAt.getTime() + 120_000))).toThrow(
      PickupRequestStatusInvalidError,
    );
  });

  it('cancel transitions otp_sent → cancelled', () => {
    const r = PickupRequest.create(validInput);
    const c = r.cancel(new Date(createdAt.getTime() + 30_000));
    expect(c).not.toBe(r);
    expect(c.status).toBe('cancelled');
  });

  it('cancel throws when called on a terminal-state row', () => {
    const v = PickupRequest.create(validInput).validate(
      staffMemberId,
      attendanceEventId,
      new Date(createdAt.getTime() + 60_000),
    );
    expect(() => v.cancel(new Date(createdAt.getTime() + 120_000))).toThrow(
      PickupRequestStatusInvalidError,
    );
  });

  it('attachOtpRef stamps otpRef without changing status', () => {
    const r = PickupRequest.create(validInput);
    const stamped = r.attachOtpRef('sms-txn-123');
    expect(stamped).not.toBe(r);
    expect(stamped.otpRef).toBe('sms-txn-123');
    expect(stamped.status).toBe('otp_sent');
    expect(r.otpRef).toBeNull();
  });

  it('attachOtpRef throws when row is in terminal state', () => {
    const v = PickupRequest.create(validInput).validate(
      staffMemberId,
      attendanceEventId,
      new Date(createdAt.getTime() + 60_000),
    );
    expect(() => v.attachOtpRef('sms-txn-123')).toThrow(
      PickupRequestStatusInvalidError,
    );
  });

  it('toState round-trips via fromState', () => {
    const original =
      PickupRequest.create(validInput).attachOtpRef('sms-txn-123');
    const rebuilt = PickupRequest.fromState(original.toState());
    expect(rebuilt.toState()).toEqual(original.toState());
  });

  it('toState round-trips via fromState in terminal state', () => {
    const original = PickupRequest.create(validInput)
      .attachOtpRef('sms-txn-123')
      .validate(
        staffMemberId,
        attendanceEventId,
        new Date(createdAt.getTime() + 60_000),
      );
    const rebuilt = PickupRequest.fromState(original.toState());
    expect(rebuilt.toState()).toEqual(original.toState());
    expect(rebuilt.status).toBe('validated');
  });
});
