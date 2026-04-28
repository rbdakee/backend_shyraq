import { ChildStatus } from './child-status.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

describe('ChildStatus', () => {
  it('exposes three sealed instances with correct values', () => {
    expect(ChildStatus.CARD_CREATED.value).toBe('card_created');
    expect(ChildStatus.ACTIVE.value).toBe('active');
    expect(ChildStatus.ARCHIVED.value).toBe('archived');
  });

  it.each([
    ['card_created', ChildStatus.CARD_CREATED],
    ['active', ChildStatus.ACTIVE],
    ['archived', ChildStatus.ARCHIVED],
  ])('fromString(%p) returns the matching instance', (raw, expected) => {
    expect(ChildStatus.fromString(raw)).toBe(expected);
  });

  it.each([['Active'], [''], ['suspended'], ['ARCHIVED']])(
    'fromString(%p) throws InvariantViolationError',
    (raw) => {
      expect(() => ChildStatus.fromString(raw)).toThrow(
        InvariantViolationError,
      );
    },
  );

  it('equals returns true for same value', () => {
    expect(ChildStatus.ACTIVE.equals(ChildStatus.fromString('active'))).toBe(
      true,
    );
  });

  it('equals returns false for different values', () => {
    expect(ChildStatus.ACTIVE.equals(ChildStatus.ARCHIVED)).toBe(false);
  });
});
