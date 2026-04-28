import { GuardianStatus } from './guardian-status.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

describe('GuardianStatus', () => {
  it('exposes four sealed instances with correct values', () => {
    expect(GuardianStatus.PENDING_APPROVAL.value).toBe('pending_approval');
    expect(GuardianStatus.APPROVED.value).toBe('approved');
    expect(GuardianStatus.REJECTED.value).toBe('rejected');
    expect(GuardianStatus.REVOKED.value).toBe('revoked');
  });

  it.each([
    ['pending_approval', GuardianStatus.PENDING_APPROVAL],
    ['approved', GuardianStatus.APPROVED],
    ['rejected', GuardianStatus.REJECTED],
    ['revoked', GuardianStatus.REVOKED],
  ])('fromString(%p) returns the matching instance', (raw, expected) => {
    expect(GuardianStatus.fromString(raw)).toBe(expected);
  });

  it.each([['pending'], [''], ['Approved'], ['archived']])(
    'fromString(%p) throws InvariantViolationError',
    (raw) => {
      expect(() => GuardianStatus.fromString(raw)).toThrow(
        InvariantViolationError,
      );
    },
  );

  it('equals returns true for same value', () => {
    expect(
      GuardianStatus.APPROVED.equals(GuardianStatus.fromString('approved')),
    ).toBe(true);
  });

  it('equals returns false for different values', () => {
    expect(
      GuardianStatus.APPROVED.equals(GuardianStatus.PENDING_APPROVAL),
    ).toBe(false);
  });
});
