import { GuardianRelation } from './guardian-relation.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

describe('GuardianRelation', () => {
  it('exposes three sealed instances with correct values', () => {
    expect(GuardianRelation.PRIMARY.value).toBe('primary');
    expect(GuardianRelation.SECONDARY.value).toBe('secondary');
    expect(GuardianRelation.NANNY.value).toBe('nanny');
  });

  it.each([
    ['primary', GuardianRelation.PRIMARY],
    ['secondary', GuardianRelation.SECONDARY],
    ['nanny', GuardianRelation.NANNY],
  ])('fromString(%p) returns the matching instance', (raw, expected) => {
    expect(GuardianRelation.fromString(raw)).toBe(expected);
  });

  it.each([['Primary'], [''], ['father'], ['NANNY']])(
    'fromString(%p) throws InvariantViolationError',
    (raw) => {
      expect(() => GuardianRelation.fromString(raw)).toThrow(
        InvariantViolationError,
      );
    },
  );

  it('equals returns true for same value', () => {
    expect(
      GuardianRelation.PRIMARY.equals(GuardianRelation.fromString('primary')),
    ).toBe(true);
  });

  it('equals returns false for different values', () => {
    expect(GuardianRelation.PRIMARY.equals(GuardianRelation.SECONDARY)).toBe(
      false,
    );
  });

  it('toString returns the snake_case literal', () => {
    expect(GuardianRelation.NANNY.toString()).toBe('nanny');
  });
});
