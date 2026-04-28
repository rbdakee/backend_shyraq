import { KindergartenId } from './kindergarten-id.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('KindergartenId', () => {
  it('parses a valid UUID', () => {
    const id = KindergartenId.parse(VALID_UUID);
    expect(id).toBe(VALID_UUID);
  });

  it('accepts uppercase UUID', () => {
    const id = KindergartenId.parse(VALID_UUID.toUpperCase());
    expect(id).toBe(VALID_UUID.toUpperCase());
  });

  it('throws InvariantViolationError for empty string', () => {
    expect(() => KindergartenId.parse('')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for non-UUID string', () => {
    expect(() => KindergartenId.parse('not-a-uuid')).toThrow(
      InvariantViolationError,
    );
  });

  it('throws InvariantViolationError for UUID with wrong length', () => {
    expect(() =>
      KindergartenId.parse('123e4567-e89b-12d3-a456-42661417400'),
    ).toThrow(InvariantViolationError);
  });
});
