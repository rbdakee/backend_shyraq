import { ChildId } from './child-id.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('ChildId', () => {
  it('parses a valid UUID', () => {
    const id = ChildId.parse(VALID_UUID);
    expect(id).toBe(VALID_UUID);
  });

  it('accepts uppercase UUID', () => {
    const id = ChildId.parse(VALID_UUID.toUpperCase());
    expect(id).toBe(VALID_UUID.toUpperCase());
  });

  it('throws InvariantViolationError for empty string', () => {
    expect(() => ChildId.parse('')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for non-UUID string', () => {
    expect(() => ChildId.parse('not-a-uuid')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for UUID with wrong length', () => {
    expect(() => ChildId.parse('123e4567-e89b-12d3-a456-42661417400')).toThrow(
      InvariantViolationError,
    );
  });
});
