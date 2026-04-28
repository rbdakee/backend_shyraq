import { Phone } from './phone.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

describe('Phone', () => {
  it('parses a valid E.164 phone number', () => {
    const phone = Phone.parse('+77001234567');
    expect(phone.toString()).toBe('+77001234567');
  });

  it('parses international number with country code 1', () => {
    const phone = Phone.parse('+12125551234');
    expect(phone.toString()).toBe('+12125551234');
  });

  it('throws InvariantViolationError for number without leading +', () => {
    expect(() => Phone.parse('77001234567')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for empty string', () => {
    expect(() => Phone.parse('')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for + only', () => {
    expect(() => Phone.parse('+')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for number starting with +0', () => {
    expect(() => Phone.parse('+0123456789')).toThrow(InvariantViolationError);
  });

  it('equals returns true for same value', () => {
    const a = Phone.parse('+77001234567');
    const b = Phone.parse('+77001234567');
    expect(a.equals(b)).toBe(true);
  });

  it('equals returns false for different values', () => {
    const a = Phone.parse('+77001234567');
    const b = Phone.parse('+77007654321');
    expect(a.equals(b)).toBe(false);
  });
});
