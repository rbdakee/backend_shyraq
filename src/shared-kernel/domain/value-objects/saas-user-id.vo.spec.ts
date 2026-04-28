import { SaasUserId } from './saas-user-id.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

const VALID_UUID = '123e4567-e89b-12d3-a456-426614174000';

describe('SaasUserId', () => {
  it('parses a valid UUID', () => {
    const id = SaasUserId.parse(VALID_UUID);
    expect(id).toBe(VALID_UUID);
  });

  it('accepts uppercase UUID', () => {
    const id = SaasUserId.parse(VALID_UUID.toUpperCase());
    expect(id).toBe(VALID_UUID.toUpperCase());
  });

  it('throws InvariantViolationError for empty string', () => {
    expect(() => SaasUserId.parse('')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for non-UUID string', () => {
    expect(() => SaasUserId.parse('not-a-uuid')).toThrow(
      InvariantViolationError,
    );
  });
});
