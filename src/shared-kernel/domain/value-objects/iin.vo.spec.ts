import { Iin } from './iin.vo';
import { InvariantViolationError } from '../errors/invariant-violation.error';

describe('Iin', () => {
  it('parses a valid 12-digit IIN', () => {
    const iin = Iin.parse('900101300123');
    expect(iin.toString()).toBe('900101300123');
  });

  it('throws InvariantViolationError for 11 digits', () => {
    expect(() => Iin.parse('90010130012')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for 13 digits', () => {
    expect(() => Iin.parse('9001013001234')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for non-digit characters', () => {
    expect(() => Iin.parse('9001013001AB')).toThrow(InvariantViolationError);
  });

  it('throws InvariantViolationError for empty string', () => {
    expect(() => Iin.parse('')).toThrow(InvariantViolationError);
  });

  it('equals returns true for same value', () => {
    const a = Iin.parse('900101300123');
    const b = Iin.parse('900101300123');
    expect(a.equals(b)).toBe(true);
  });

  it('equals returns false for different values', () => {
    const a = Iin.parse('900101300123');
    const b = Iin.parse('900101300124');
    expect(a.equals(b)).toBe(false);
  });
});
